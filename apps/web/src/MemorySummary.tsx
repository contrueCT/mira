import { memoryBlocks } from './management.ts';

export function MemorySummary({ text }: { text: string }) {
  const blocks = memoryBlocks(text);
  if (!blocks.length) return <p className="management-empty">还没有记忆内容。你可以在下方告诉 Mira 想记住什么。</p>;
  return <div className="memory-summary">{blocks.map((block, index) => {
    if (block.kind === 'heading') return block.level === 1 ? <h3 key={index}>{block.text}</h3> : block.level === 2 ? <h4 key={index}>{block.text}</h4> : <h5 key={index}>{block.text}</h5>;
    if (block.kind === 'list') return block.ordered ? <ol key={index}>{block.items.map((item, at) => <li key={at}>{item}</li>)}</ol> : <ul key={index}>{block.items.map((item, at) => <li key={at}>{item}</li>)}</ul>;
    if (block.kind === 'code') return <pre key={index}>{block.text}</pre>;
    return <p key={index}>{block.text}</p>;
  })}</div>;
}
