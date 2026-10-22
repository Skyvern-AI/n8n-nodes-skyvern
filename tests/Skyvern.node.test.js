const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Skyvern } = require('../dist/nodes/Skyvern/Skyvern.node.js');

const pageSize = 100;

function makeContext({ request }) {
    const calls = [];
    const nodeParameters = {
        resource: 'workflow',
        workflowOperation: 'dispatchWorkflow',
        workflowId: 'workflow-id',
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

// QA repro (DO NOT MERGE): the n8n editor stores a resource-mapper "object" field as JSON text,
// and declarative routing reads the whole resourceMapper parameter, so n8n never converts it.
// 0.0.11 sent this value and the API parsed it; the new preSend rejects it.
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

// QA repro (DO NOT MERGE): run-time credential inputs are workflow parameters with
// workflow_parameter_type "credential_id". The picker only handles parameter_type "credential"
// (a fixed credential the API never reads from run data), so these inputs get no type and no picker.
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

// QA repro (DO NOT MERGE): these behaviours had no test; each one-line mutation of them kept the suite green.
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
