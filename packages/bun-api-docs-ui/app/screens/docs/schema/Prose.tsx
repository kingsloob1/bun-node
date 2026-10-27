import type { ReactNode } from "react";

/** Props of {@link Prose}. */
export interface ProseProps {
  /** The text: a spec's `description`, which may carry `` `code` `` spans and blank-line paragraphs. */
  text: string;
  /** Extra class names on each paragraph. */
  className?: string;
}

/** Splits one paragraph into text and `<code>` spans at backticks. */
function inlineCode(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/).map((part, index) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      // eslint-disable-next-line react/no-array-index-key -- the split is fixed for a given text
      <code key={index}>{part.slice(1, -1)}</code>
    ) : (
      part
    ),
  );
}

/**
 * A spec description as paragraphs, with backtick spans as code. Nothing
 * else of Markdown is interpreted, and no HTML is ever injected: a spec is
 * data from the API, rendered as text.
 */
export function Prose({ text, className }: ProseProps) {
  const paragraphs = text.split(/\n\s*\n/).filter((part) => part.trim() !== "");
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p
          // eslint-disable-next-line react/no-array-index-key -- paragraphs of a fixed text
          key={index}
          className={className}
        >
          {inlineCode(paragraph)}
        </p>
      ))}
    </>
  );
}
