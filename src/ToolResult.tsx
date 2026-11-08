import type {ReactNode} from 'react';
/** Shared by the real investigation and the guided example. */
export function ToolResult({tool,query,result,conclusion}:{tool:ReactNode;query:ReactNode;result:ReactNode;conclusion:ReactNode}){
 return <div className="tool-result"><dl><dt>Tool</dt><dd>{tool}</dd><dt>Query</dt><dd>{query}</dd><dt>Result</dt><dd>{result}</dd><dt>Conclusion</dt><dd>{conclusion}</dd></dl></div>;
}
