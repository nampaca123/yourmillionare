// CDK app entry: loads validated env, instantiates env-prefixed stacks, attaches cdk-nag and tags.

import { App, Aspects, Tags } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

import { loadEnvConfig } from '../lib/config/env.config.js';
import { FoundationStack } from '../lib/stacks/foundation.stack.js';

const config = loadEnvConfig();

const app = new App();

Tags.of(app).add('Project', 'yourmillionare');
Tags.of(app).add('Environment', config.env);
Tags.of(app).add('ManagedBy', 'cdk');
Tags.of(app).add('Owner', 'platform');

new FoundationStack(app, `${config.stackPrefix}-Foundation`, {
  env: { account: config.account, region: config.region },
  deploymentEnv: config.env,
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

app.synth();
