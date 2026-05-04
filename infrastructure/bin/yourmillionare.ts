// CDK app entry: loads validated env, instantiates env-prefixed stacks, attaches cdk-nag and tags.

import { App, Aspects, Tags } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

import { loadEnvConfig } from '../lib/config/env.config.js';
import { FoundationStack } from '../lib/stacks/foundation.stack.js';
import { NetworkStack } from '../lib/stacks/network.stack.js';
import { DataStack } from '../lib/stacks/data.stack.js';

const config = loadEnvConfig();
const env = { account: config.account, region: config.region };

const app = new App();

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
});
network.addDependency(foundation);

const data = new DataStack(app, `${config.stackPrefix}-Data`, {
  env,
  deploymentEnv: config.env,
  vpc: network.vpc,
  lambdaSg: network.lambdaSg,
  auroraSg: network.auroraSg,
  sharedKey: foundation.sharedKey,
});
data.addDependency(network);
data.addDependency(foundation);

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

app.synth();
