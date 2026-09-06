/**
 * The three-method logger every module takes by injection. Nothing in `src/`
 * writes to stdout — that is the MCP protocol channel — and nothing below
 * `cli.ts` writes to stderr directly either, so an embedder can capture or
 * silence every line through this one seam.
 */
export type Logger = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};
