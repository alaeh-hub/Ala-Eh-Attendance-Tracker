/*
 * Boot loader: the word settles letter by letter, then a dot rides under it.
 * Adapted from Vengeance UI "kinetic-text-loader" (MIT, https://www.vengenceui.com), re-set in the display face and brand token.
 * Keyframes live in index.css (.kl-*).
 */
export default function KineticLoader({ text = "Loading" }: { text?: string }) {
  return (
    <p className="kl font-display" aria-label={text}>
      {text.split("").map((c, i) => (
        <span key={i} className="kl-letter" style={{ animationDelay: `${i * 90}ms` }} aria-hidden="true">
          {c}
        </span>
      ))}
      <span className="kl-dot" aria-hidden="true" />
    </p>
  );
}
