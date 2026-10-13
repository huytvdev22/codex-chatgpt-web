/**
 * Facade tương thích ngược cho BashCommandTranslator
 */
export {
  BashCommandTranslator,
  stripShellPrefix,
  CatRule,
  LsRule,
  GrepRule,
  GitStatusRule,
  GitDiffRule,
  FindRule,
  isDestructiveCommand,
  type IBashCommandRule,
} from "../../base-web/translation";
