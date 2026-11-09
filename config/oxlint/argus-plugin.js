// Local oxlint JS plugin (no dependency). Oxlint has no built-in no-restricted-syntax, so this is the equivalent.
const MESSAGE =
  'RegExp built from a non-literal. A pattern built from input can hang the worker (ReDoS) or match unintended text. ' +
  'Use a regex or string literal, or a linear matcher (hand-written scan, no backtracking); untrusted input never becomes a pattern. ' +
  'See docs/agents/worker-rules.md.';

function isLiteralPattern(node) {
  if (node.type === 'Literal') return true; // string or regex literal
  return node.type === 'TemplateLiteral' && node.expressions.length === 0;
}

function check(context, node) {
  if (node.callee.type !== 'Identifier' || node.callee.name !== 'RegExp') return;
  const first = node.arguments[0];
  if (first && !isLiteralPattern(first)) context.report({ node, message: MESSAGE });
}

export default {
  meta: { name: 'argus' },
  rules: {
    'no-dynamic-regexp': {
      create(context) {
        return {
          NewExpression: (node) => check(context, node),
          CallExpression: (node) => check(context, node),
        };
      },
    },
  },
};
