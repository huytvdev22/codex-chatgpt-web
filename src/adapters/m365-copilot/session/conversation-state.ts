export interface ConversationGuardState {
  toolIterations: number;
  lastToolFingerprint?: string;
  identicalToolCount: number;
  updatedAt: number;
}
