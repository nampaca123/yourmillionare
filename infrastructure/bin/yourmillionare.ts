// CDK app entry: loads validated env, instantiates env-prefixed stacks, attaches cdk-nag and tags.

import { App, Aspects, Tags } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

import { loadEnvConfig } from '../lib/config/env.config.js';
import { FoundationStack } from '../lib/stacks/foundation.stack.js';
import { NetworkStack } from '../lib/stacks/network.stack.js';
import { DataStack } from '../lib/stacks/data.stack.js';
import { IdentityStack } from '../lib/stacks/identity.stack.js';
import { ApiStack } from '../lib/stacks/api.stack.js';
import { IngestionStack } from '../lib/stacks/ingestion.stack.js';

const config = loadEnvConfig();
const env = { account: config.account, region: config.region };

const app = new App();

// Pre-populate AZ context so Vpc does not emit a "missing context" entry.
// CDK's Vpc always requests this lookup even when availabilityZones is passed
// explicitly; without the cached value CDK CLI tries to call EC2 DescribeAZs at
// synth time, which fails in CI (dummy account, no credentials).
const regionAzs = [`${config.region}a`, `${config.region}b`, `${config.region}c`];
app.node.setContext(`availability-zones:account=${config.account}:region=${config.region}`, regionAzs);

Tags.of(app).add('Project', 'yourmillionare');
Tags.of(app).add('Environment', config.env);
Tags.of(app).add('ManagedBy', 'cdk');
Tags.of(app).add('Owner', 'platform');

const foundation = new FoundationStack(app, `${config.stackPrefix}-Foundation`, {
  env,
  deploymentEnv: config.env,
});

const network = new NetworkStack(app, `${config.stackPrefix}-Network`, {
  env,
  deploymentEnv: config.env,
  vpcCidr: config.vpcCidr,
  availabilityZones: [`${config.region}a`, `${config.region}b`, `${config.region}c`],
});
network.addDependency(foundation);

const data = new DataStack(app, `${config.stackPrefix}-Data`, {
  env,
  deploymentEnv: config.env,
  vpc: network.vpc,
  lambdaSg: network.lambdaSg,
  auroraSg: network.auroraSg,
  sharedKey: foundation.sharedKey,
  availabilityZones: [`${config.region}a`, `${config.region}b`, `${config.region}c`],
});
data.addDependency(network);
data.addDependency(foundation);

const identity = new IdentityStack(app, `${config.stackPrefix}-Identity`, {
  env,
  deploymentEnv: config.env,
});
identity.addDependency(foundation);

const api = new ApiStack(app, `${config.stackPrefix}-Api`, {
  env,
  deploymentEnv: config.env,
  vpc: network.vpc,
  lambdaSg: network.lambdaSg,
  aurora: data.aurora,
  cache: data.cache,
  identity,
  sharedKey: foundation.sharedKey,
});
api.addDependency(network);
api.addDependency(data);
api.addDependency(identity);

new IngestionStack(app, `${config.stackPrefix}-Ingestion`, {
  env,
  deploymentEnv: config.env,
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

app.synth();
