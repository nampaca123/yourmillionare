// Construct: Bedrock Knowledge Base wired to Aurora pgvector storage + S3 data source for legal corpus retrieval.

import { CfnResource, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Effect, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import type { DatabaseCluster } from 'aws-cdk-lib/aws-rds';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const EMBED_MODEL_DEFAULT = 'amazon.titan-embed-text-v2:0';
const EMBED_DIMENSION_DEFAULT = 1024;
const INCLUSION_PREFIX = 'chunks/';
const KB_TABLE_NAME = 'bedrock_integration.bedrock_kb_legal';
const KB_DATABASE_NAME = 'yourmillionare';

export interface LegalKbConstructProps {
  readonly corpusBucket: IBucket;
  readonly kbName: string;
  readonly auroraCluster: DatabaseCluster;
  readonly auroraKbSecret: ISecret;
  readonly auroraKbSecretKey: IKey;
  readonly embedModel?: string;
  readonly embedDimension?: number;
  readonly embedRegion?: string;
}

export class LegalKbConstruct extends Construct {
  public readonly kbId: string;
  public readonly dataSourceId: string;
  public readonly kbArn: string;

  constructor(scope: Construct, id: string, props: LegalKbConstructProps) {
    super(scope, id);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;
    const embedModel = props.embedModel ?? EMBED_MODEL_DEFAULT;
    const embedDimension = props.embedDimension ?? EMBED_DIMENSION_DEFAULT;
    const embedRegion = props.embedRegion ?? region;
    const embedModelArn = `arn:aws:bedrock:${embedRegion}::foundation-model/${embedModel}`;

    const kbRole = new Role(this, 'KbRole', {
      assumedBy: new ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${region}:${account}:knowledge-base/*` },
        },
      }),
      inlinePolicies: {
        S3Corpus: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: [props.corpusBucket.bucketArn, `${props.corpusBucket.bucketArn}/*`],
              conditions: { StringEquals: { 'aws:ResourceAccount': account } },
            }),
          ],
        }),
        BedrockEmbed: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['bedrock:InvokeModel'],
              resources: [embedModelArn],
            }),
          ],
        }),
        RdsDataApi: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                'rds-data:ExecuteStatement',
                'rds-data:BatchExecuteStatement',
                'rds-data:BeginTransaction',
                'rds-data:CommitTransaction',
                'rds-data:RollbackTransaction',
              ],
              resources: [props.auroraCluster.clusterArn],
            }),
          ],
        }),
        SecretAccess: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['secretsmanager:GetSecretValue'],
              resources: [props.auroraKbSecret.secretArn],
            }),
          ],
        }),
        KmsDecrypt: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['kms:Decrypt'],
              resources: [props.auroraKbSecretKey.keyArn],
            }),
          ],
        }),
      },
    });

    NagSuppressions.addResourceSuppressions(
      kbRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Bedrock KB ingestion role needs s3:GetObject across the corpus bucket prefix (chunks/*) because corpus object keys are generated dynamically per law revision. All other resources are scoped to specific ARNs.',
        },
      ],
      true,
    );

    const kb = new CfnResource(this, 'KnowledgeBase', {
      type: 'AWS::Bedrock::KnowledgeBase',
      properties: {
        Name: props.kbName,
        RoleArn: kbRole.roleArn,
        KnowledgeBaseConfiguration: {
          Type: 'VECTOR',
          VectorKnowledgeBaseConfiguration: {
            EmbeddingModelArn: embedModelArn,
            EmbeddingModelConfiguration: {
              BedrockEmbeddingModelConfiguration: {
                Dimensions: embedDimension,
                EmbeddingDataType: 'FLOAT32',
              },
            },
          },
        },
        StorageConfiguration: {
          Type: 'RDS',
          RdsConfiguration: {
            ResourceArn: props.auroraCluster.clusterArn,
            CredentialsSecretArn: props.auroraKbSecret.secretArn,
            DatabaseName: KB_DATABASE_NAME,
            TableName: KB_TABLE_NAME,
            FieldMapping: {
              PrimaryKeyField: 'id',
              VectorField: 'embedding',
              TextField: 'chunks',
              MetadataField: 'metadata',
              CustomMetadataField: 'custom_metadata',
            },
          },
        },
      },
    });
    kb.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.kbId = kb.getAtt('KnowledgeBaseId').toString();
    this.kbArn = kb.getAtt('KnowledgeBaseArn').toString();

    const dataSource = new CfnResource(this, 'DataSource', {
      type: 'AWS::Bedrock::DataSource',
      properties: {
        KnowledgeBaseId: this.kbId,
        Name: `${props.kbName}-s3-chunks`,
        DataSourceConfiguration: {
          Type: 'S3',
          S3Configuration: {
            BucketArn: props.corpusBucket.bucketArn,
            InclusionPrefixes: [INCLUSION_PREFIX],
          },
        },
        VectorIngestionConfiguration: {
          ChunkingConfiguration: { ChunkingStrategy: 'NONE' },
        },
        DataDeletionPolicy: 'RETAIN',
      },
    });
    dataSource.addDependency(kb);
    this.dataSourceId = dataSource.getAtt('DataSourceId').toString();
  }
}
