/**
 * Hợp đồng phân giải slug thành Mode nội bộ
 */
export interface IModelResolver<TMode extends string = string> {
  resolve(modelSlug?: string, reasoning?: string): TMode;
  supports(modelSlug: string): boolean;
}
