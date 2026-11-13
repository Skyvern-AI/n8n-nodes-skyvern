const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Skyvern } = require('../dist/nodes/Skyvern/Skyvern.node.js');

const pageSize = 100;

function makeContext({ request, parameters = {} }) {
    const calls = [];
    const nodeParameters = {
        resource: 'workflow',
        workflowOperation: 'dispatchWorkflow',
        workflowId: 'workflow-id',
        ...parameters,
    };
    return {
        calls,
        getCredentials: async () => ({ baseUrl: 'https://example.test' }),
        getCurrentNodeParameter: (name) => nodeParameters[name],
        getNodeParameter: (name) => nodeParameters[name],
        getNode: () => ({ name: 'Skyvern' }),
        helpers: {
            requestWithAuthentication: async (_credentialName, options) => {
                calls.push(options.url);
                return request(options.url);
            },
        },
    };
}

function pageFrom(url) {
    return Number(new URL(url, 'https://example.test').searchParams.get('page') || 1);
}

test('workflow picker loads every page', async () => {
    const context = makeContext({
        request: (url) => {
            const page = pageFrom(url);
            const count = page === 1 ? pageSize : page === 2 ? 1 : 0;
            return Array.from({ length: count }, (_, index) => ({
                title: `Workflow ${index}`,
                workflow_permanent_id: `${page}-${index}`,
            }));
        },
    });

    const workflows = await new Skyvern().methods.loadOptions.getWorkflows.call(context);

    assert.equal(workflows.length, pageSize + 1);
    assert.equal(context.calls.length, 2);
});

test('credential picker loads every page', async () => {
    const context = makeContext({
        request: (url) => {
            if (url.startsWith('/api/v1/workflows/')) {
                return {
                    workflow_definition: {
                        parameters: [{ key: 'account', parameter_type: 'workflow', workflow_parameter_type: 'credential_id', default_value: null }],
                    },
                };
            }
            const page = pageFrom(url);
            const count = page === 1 ? pageSize : page === 2 ? 1 : 0;
            return Array.from({ length: count }, (_, index) => ({
                name: `Credential ${index}`,
                credential_id: `${page}-${index}`,
            }));
        },
    });

    const fields = await new Skyvern().methods.resourceMapping.getWorkflowRunParameters.call(context);

    assert.equal(fields.fields[0].options.length, pageSize + 1);
    assert.equal(context.calls.filter((url) => url.startsWith('/api/v1/credentials')).length, 2);
});

test('credential lookup failure falls back to a plain input', async () => {
    const context = makeContext({
        request: (url) => {
            if (url.startsWith('/api/v1/workflows/')) {
                return {
                    workflow_definition: {
                        parameters: [{ key: 'account', parameter_type: 'workflow', workflow_parameter_type: 'credential_id', default_value: null }],
                    },
                };
            }
            throw new Error('credential lookup failed');
        },
    });

    const fields = await new Skyvern().methods.resourceMapping.getWorkflowRunParameters.call(context);

    assert.equal(fields.fields[0].type, 'string');
    assert.equal(fields.fields[0].options, undefined);
});

test('invalid workflow parameter types fail before dispatch', async () => {
    const context = makeContext({
        request: (url) => {
            assert.equal(url, '/api/v1/workflows/workflow-id');
            return {
                workflow_definition: {
                    parameters: [{ key: 'count', parameter_type: 'workflow', workflow_parameter_type: 'integer' }],
                },
            };
        },
    });
    const operation = new Skyvern().description.properties.find((property) => property.name === 'workflowOperation');
    const preSend = operation.routing.send.preSend[0];

    await assert.rejects(
        () => preSend.call(context, { body: { data: { count: 'not a number' } } }),
        /count.*integer/i,
    );
    assert.equal(context.calls.length, 1);
});

test('browser session options map to top-level request fields', () => {
    const options = new Skyvern().description.properties.find((property) => property.name === 'workflowOptions');
    assert.ok(options);
    for (const [name, field] of [
        ['browserSessionId', 'browser_session_id'],
        ['browserProfileId', 'browser_profile_id'],
    ]) {
        const property = options.options.find((option) => option.name === name);
        assert.equal(property.routing.request.body[field], '={{$value ? $value : null}}');
    }
});

// Regression: the n8n editor stores a resource-mapper "object" field as JSON text, and declarative
// routing passes it through unconverted, so preSend must accept JSON text.
test('JSON parameter typed in the n8n editor is accepted', async () => {
    const context = makeContext({
        request: () => ({
            workflow_definition: {
                parameters: [{ key: 'config', parameter_type: 'workflow', workflow_parameter_type: 'json' }],
            },
        }),
    });
    const operation = new Skyvern().description.properties.find((property) => property.name === 'workflowOperation');
    const preSend = operation.routing.send.preSend[0];

    await assert.doesNotReject(() => preSend.call(context, { body: { data: { config: '{"k": 1}' } } }));
});

test('fixed credential parameters are not run inputs', async () => {
    const context = makeContext({
        request: (url) => {
            if (url.startsWith('/api/v1/workflows/')) {
                return {
                    workflow_definition: {
                        parameters: [{ key: 'fixedCredential', parameter_type: 'credential', default_value: null }],
                    },
                };
            }
            return [];
        },
    });

    const fields = await new Skyvern().methods.resourceMapping.getWorkflowRunParameters.call(context);

    assert.equal(fields.fields.some((field) => field.id === 'fixedCredential'), false);
});

for (const [type, value] of [
    ['integer', '5'],
    ['boolean', 'true'],
    ['boolean', 'false'],
]) {
    test(`API-coercible ${type} string is accepted`, async () => {
        const context = makeContext({
            request: () => ({
                workflow_definition: {
                    parameters: [{ key: 'field', parameter_type: 'workflow', workflow_parameter_type: type }],
                },
            }),
        });
        const operation = new Skyvern().description.properties.find((property) => property.name === 'workflowOperation');
        const preSend = operation.routing.send.preSend[0];

        await assert.doesNotReject(() => preSend.call(context, { body: { data: { field: value } } }));
    });
}

// Regression: run-time credential inputs are workflow parameters with workflow_parameter_type
// "credential_id" and must get the credential picker; fixed "credential" parameters are not run inputs.
test('credential_id workflow input gets the credential picker', async () => {
    const context = makeContext({
        request: (url) => {
            if (url.startsWith('/api/v1/workflows/')) {
                return {
                    workflow_definition: {
                        parameters: [
                            { key: 'login', parameter_type: 'workflow', workflow_parameter_type: 'credential_id', default_value: null },
                        ],
                    },
                };
            }
            return [{ name: 'Credential A', credential_id: 'cred_a' }];
        },
    });

    const fields = await new Skyvern().methods.resourceMapping.getWorkflowRunParameters.call(context);

    assert.equal(fields.fields[0].type, 'options');
    assert.deepEqual(fields.fields[0].options, [{ name: 'Credential A', value: 'cred_a' }]);
});

// Regression coverage for the Get path and boolean/JSON validation.
test('Get a Workflow Run path carries both the workflow and the run ID', () => {
    const runId = new Skyvern().description.properties.find((property) => property.name === 'workflowRunId');
    const url = runId.routing.request.url;
    assert.match(url, /\$parameter\["workflowId"\]/);
    assert.match(url, /\/runs\/" \+ \$value/);
});

for (const [type, wrong] of [
    ['boolean', 'yes'],
    ['json', 42],
    ['float', 'NaN'],
    ['credential_id', 7],
]) {
    test(`invalid ${type} workflow parameter fails before dispatch`, async () => {
        const context = makeContext({
            request: () => ({
                workflow_definition: {
                    parameters: [{ key: 'field', parameter_type: 'workflow', workflow_parameter_type: type }],
                },
            }),
        });
        const operation = new Skyvern().description.properties.find((property) => property.name === 'workflowOperation');
        const preSend = operation.routing.send.preSend[0];

        await assert.rejects(() => preSend.call(context, { body: { data: { field: wrong } } }), /field/);
        assert.equal(context.calls.length, 1);
    });
}

// Exercise the declarative dispatch hook with expression values, preserving the request
// so the API remains responsible for converting saved-node parameter values.
for (const [type, values] of [
    ['float', ['5', '5.5', ' 2.25 ', '-.5', '+5.', '1e3', '-2.5E-2', '1_000.5', 5.5]],
    ['boolean', ['1', '0', 'True', 'FALSE', 'tRuE', 'fAlSe', 1, 0, true, false]],
    ['string', [42, 4.2, true, false, 0, ['a', 1], { key: 'value' }, '42']],
    ['integer', ['5', ' 5 ', '-3', '+7', 5]],
    ['json', ['{"k": 1}', '[1,2]', { k: 1 }, [1, 2]]],
]) {
    for (const value of values) {
        test(`dispatch preserves API-compatible ${type} ${typeof value} ${JSON.stringify(value)}`, async () => {
            const context = makeContext({
                request: (url) => {
                    assert.equal(url, '/api/v1/workflows/workflow-id');
                    return {
                        workflow_definition: {
                            parameters: [{ key: 'field', parameter_type: 'workflow', workflow_parameter_type: type }],
                        },
                    };
                },
            });
            const operation = new Skyvern().description.properties.find((property) => property.name === 'workflowOperation');
            const requestOptions = { body: { data: { field: value } } };
            const before = structuredClone(requestOptions);

            const result = await operation.routing.send.preSend[0].call(context, requestOptions);

            assert.equal(result, requestOptions);
            assert.deepEqual(result, before);
            assert.equal(context.calls.length, 1);
        });
    }
}

for (const [type, values, expected] of [
    ['float', ['abc', '', '   ', '0x10', '0b10', '0o10', '5x', '1__0', '_5', '5_', '1e999', 'NaN', 'Infinity', NaN, Infinity, true, {}, []], 'a number'],
    ['boolean', ['yes', '2', ' true ', ' 1 ', 'true\n', 'false\r', '1\n', 2, -1, {}, [], ['true'], [1]], 'a boolean'],
    ['integer', ['5.5', 'abc', '1e3', true, 5.5], 'an integer'],
    ['json', ['{bad', '', '   '], 'a JSON object or array'],
    ['credential_id', [7, {}], 'a credential ID'],
    ['file_url', [42, true, {}], 'a string'],
]) {
    for (const [index, value] of values.entries()) {
        test(`dispatch rejects malformed ${type} case ${index}: ${String(value)}`, async () => {
            const context = makeContext({
                request: () => ({
                    workflow_definition: {
                        parameters: [{ key: 'field', parameter_type: 'workflow', workflow_parameter_type: type }],
                    },
                }),
            });
            const operation = new Skyvern().description.properties.find((property) => property.name === 'workflowOperation');

            await assert.rejects(
                () => operation.routing.send.preSend[0].call(context, { body: { data: { field: value } } }),
                { message: `Workflow parameter "field" must be ${expected}.` },
            );
            assert.equal(context.calls.length, 1);
        });
    }
}

test('Get a Workflow Run skips dispatch validation and workflow lookup', async () => {
    const context = makeContext({
        parameters: { workflowOperation: 'getWorkflow' },
        request: () => assert.fail('Get must not load the workflow for dispatch validation'),
    });
    const operation = new Skyvern().description.properties.find((property) => property.name === 'workflowOperation');
    const requestOptions = { body: { data: { field: 'not a number' } } };

    assert.equal(await operation.routing.send.preSend[0].call(context, requestOptions), requestOptions);
    assert.equal(context.calls.length, 0);
});
