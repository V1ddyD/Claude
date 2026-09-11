import { S1, S3, S5, S7 } from './models-combustion';
import { X7, GT, R, T4 } from './models-utility';
import { E2, E5 } from './models-electric';
import type { ModelSeed } from './types';

export const SINCLAIR_CATALOGUE: ModelSeed[] = [S1, S3, S5, S7, X7, GT, R, T4, E2, E5];
export type { ModelSeed } from './types';
