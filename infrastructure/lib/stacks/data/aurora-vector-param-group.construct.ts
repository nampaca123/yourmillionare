// Aurora vector parameter group: tuned for pgvector HNSW workloads + pg_bigm preload.

import { ParameterGroup } from 'aws-cdk-lib/aws-rds';
import type { IEngine, IParameterGroup } from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export interface AuroraVectorParamGroupProps {
  readonly engine: IEngine;
}

export class AuroraVectorParamGroup extends Construct {
  public readonly parameterGroup: IParameterGroup;

  constructor(scope: Construct, id: string, props: AuroraVectorParamGroupProps) {
    super(scope, id);

    this.parameterGroup = new ParameterGroup(this, 'ParamGroup', {
      engine: props.engine,
      description: 'Aurora pg15 with pg_bigm preload and vector workload tuning',
      parameters: {
        shared_preload_libraries: 'pg_bigm',
        work_mem: '65536',
        maintenance_work_mem: '262144',
        max_parallel_workers_per_gather: '2',
      },
    });
  }
}
