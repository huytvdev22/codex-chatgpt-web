export interface RawToolCallDto {
  name: string;
  arguments: Record<string, unknown> | string;
}
