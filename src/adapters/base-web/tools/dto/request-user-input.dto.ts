export interface RequestUserInputOptionDto {
  label: string;
  description?: string;
}

export interface RequestUserInputQuestionDto {
  id: string;
  header: string;
  question: string;
  is_other?: boolean;
  is_secret?: boolean;
  options: RequestUserInputOptionDto[];
}
