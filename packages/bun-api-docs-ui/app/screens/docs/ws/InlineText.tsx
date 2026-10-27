/** Props of {@link InlineText}. */
export interface InlineTextProps {
  /** One line of spec text, whose backtick spans are code. */
  text: string;
}

/**
 * One line of spec text with its `` `code` `` spans as `<code>`: the inline
 * half of the shared `Prose`, which does not export it. No HTML is injected.
 */
export function InlineText({ text }: InlineTextProps) {
  const parts = text.split(/(`[^`]+`)/);
  return (
    <>
      {parts.map((part, index) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          // eslint-disable-next-line react/no-array-index-key -- the split is fixed for a given text
          <code key={index}>{part.slice(1, -1)}</code>
        ) : (
          part
        ),
      )}
    </>
  );
}
