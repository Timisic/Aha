export interface AhaResultValidation {
  ok: boolean;
  errors: string[];
}

export declare const AHA_RESULT_SCHEMA: unknown;
export declare const RELATIONS: Set<string>;
export declare function validateAhaResult(value: unknown): AhaResultValidation;
