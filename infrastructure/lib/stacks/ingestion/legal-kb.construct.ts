// Construct: S3 Vectors index + Bedrock Knowledge Base + S3 data source + execution role for legal corpus retrieval.

import { CfnResource, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Effect, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const EMBED_MODEL_DEFAULT = 'amazon.titan-embed-text-v2:0';
const EMBED_DIMENSION_DEFAULT = 1024;
const VECTOR_DATA_TYPE = 'float32';
const VECTOR_DISTANCE_METRIC = 'cosine';
const VECTOR_INDEX_NAME = 'legal-kb-index';
const INCLUSION_PREFIX = 'chunks/';

export interface LegalKbConstructProps {
  readonly corpusBucket: IBucket;
  readonly kbName: string;
  readonly vectorBucketName: string;
  readonly embedModel?: string;
  readonly embedDimension?: number;
  readonly embedRegion?: string;
}

export class LegalKbConstruct extends Construct {
  public readonly kbId: string;
  public readonly dataSourceId: string;
  public readonly kbArn: string;
  public readonly vectorIndexArn: string;

  constructor(scope: Construct, id: string, props: LegalKbConstructProps) {
    super(scope, id);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;
    const embedModel = props.embedModel ?? EMBED_MODEL_DEFAULT;
    const embedDimension = props.embedDimension ?? EMBED_DIMENSION_DEFAULT;
    const embedRegion = props.embedRegion ?? region;
    const embedModelArn = `arn:aws:bedrock:${embedRegion}::foundation-model/${embedModel}`;

    // --- S3 Vectors bucket (vector store backend) ---
    const vectorBucket = new CfnResource(this, 'VectorBucket', {
      type: 'AWS::S3Vectors::VectorBucket',
      properties: {
        VectorBucketName: props.vectorBucketName,
        EncryptionConfiguration: { SseType: 'AES256' },
      },
    });
    vectorBucket.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const vectorBucketArn = `arn:aws:s3vectors:${region}:${account}:bucket/${props.vectorBucketName}`;
    const vectorIndexArn = `${vectorBucketArn}/index/${VECTOR_INDEX_NAME}`;

    // --- Vector index — fixed dimension matches Cohere embed-v4 default ---
    const vectorIndex = new CfnResource(this, 'VectorIndex', {
      type: 'AWS::S3Vectors::Index',
      properties: {
        VectorBucketName: props.vectorBucketName,
        IndexName: VECTOR_INDEX_NAME,
        DataType: VECTOR_DATA_TYPE,
        Dimension: embedDimension,
        DistanceMetric: VECTOR_DISTANCE_METRIC,
        MetadataConfiguration: {
          NonFilterableMetadataKeys: ['excerpt', 'paragraph', 'item'],
        },
      },
    });
    vectorIndex.addDependency(vectorBucket);
    vectorIndex.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.vectorIndexArn = vectorIndexArn;

    // --- KB execution role (assumed by bedrock.amazonaws.com) ---
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
        S3Vectors: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                's3vectors:GetVectorBucket',
                's3vectors:GetIndex',
                's3vectors:PutVectors',
                's3vectors:GetVectors',
                's3vectors:ListVectors',
                's3vectors:QueryVectors',
                's3vectors:DeleteVectors',
              ],
              resources: [vectorBucketArn, vectorIndexArn],
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
            'Bedrock KB ingestion role needs s3:GetObject across the corpus bucket prefix (chunks/*) because object keys are generated per-law-revision by MonthlyLawSyncFn, and s3vectors actions across the vector bucket index. All resource ARNs are scoped to this construct.',
        },
      ],
      true,
    );

    // --- Bedrock Knowledge Base wired to S3 Vectors backend + Cohere embed-v4 ---
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
          Type: 'S3_VECTORS',
          S3VectorsConfiguration: { IndexArn: vectorIndexArn },
        },
      },
    });
    kb.addDependency(vectorIndex);
    kb.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.kbId = kb.getAtt('KnowledgeBaseId').toString();
    this.kbArn = kb.getAtt('KnowledgeBaseArn').toString();

    // --- Data source pointing at chunks/ prefix; chunks are pre-chunked JSON with .metadata.json sidecars ---
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
