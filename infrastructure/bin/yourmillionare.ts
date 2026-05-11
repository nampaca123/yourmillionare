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

// Google OAuth: required at deploy time, but synth (CI) uses placeholders so the
// CDK template can be rendered without exposing the real client secret to CI.
// Placeholder strings yield a syntactically valid (but non-functional) UserPoolIdentityProviderGoogle
// resource — deploy will overwrite with real values from the operator's environment.
const googleClientId = process.env.GOOGLE_OAUTH_CLIENT ?? 'placeholder.apps.googleusercontent.com';
const googleClientSecret = process.env.GOOGLE_OAUTH_SECRET ?? 'placeholder-secret-do-not-deploy';

const cognitoDomainPrefix = process.env.COGNITO_DOMAIN_PREFIX
  ?? `yourmillionare-${config.env}`;

const callbackUrls = (process.env.COGNITO_CALLBACK_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const logoutUrls = (process.env.COGNITO_LOGOUT_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = new App();

// Pre-populate AZ context so Vpc does not emit a "missing context" entry.
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
  googleClientId,
  googleClientSecret,
  cognitoDomainPrefix,
  callbackUrls,
  logoutUrls,
});
identity.addDependency(foundation);

const ingestion = new IngestionStack(app, `${config.stackPrefix}-Ingestion`, {
  env,
  deploymentEnv: config.env,
  vpc: network.vpc,
  lambdaSg: network.lambdaSg,
  aurora: data.aurora,
  codefSecretArn: foundation.codefCredentialSecret.secretArn,
  transactionCache: data.cache.transactionCache,
});
ingestion.addDependency(network);
ingestion.addDependency(data);
ingestion.addDependency(foundation);

const api = new ApiStack(app, `${config.stackPrefix}-Api`, {
  env,
  deploymentEnv: config.env,
  vpc: network.vpc,
  lambdaSg: network.lambdaSg,
  aurora: data.aurora,
  cache: data.cache,
  identity,
  sharedKey: foundation.sharedKey,
  codefSecret: foundation.codefCredentialSecret,
  manualSyncStateMachineArn: ingestion.manualSyncStateMachineArn,
  legalSyncStateMachineArn: ingestion.legalSyncStateMachineArn,
});
api.addDependency(network);
api.addDependency(data);
api.addDependency(identity);
api.addDependency(foundation);
api.addDependency(ingestion);

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

app.synth();
