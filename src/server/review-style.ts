export const themeColor = "#07090d";

export const reviewStyle = `
:root {
  color-scheme: dark;
  --canvas: ${themeColor};
  --panel: #10151d;
  --line: #263140;
  --field-edge: #5d6e84;
  --text: #f2f5f7;
  --soft: #acbcd0;
  --muted: #8693a2;
  --cyan: #38d6ff;
  --cyan-edge: #38d6ff47;
  --cyan-tint: #38d6ff12;
  --amber: #ffbd59;
  --green: #6de39a;
  --red: #ff685f;
  font: 100%/1.5 Inter, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  color: var(--text);
  background: var(--canvas);
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(ellipse at 75% 0, var(--cyan-tint), transparent 32rem),
    linear-gradient(90deg, #ffffff04 1px, transparent 1px) 0 0 / 40px 40px,
    linear-gradient(#ffffff04 1px, transparent 1px) 0 0 / 40px 40px;
}
main {
  --gutter: clamp(.875rem, 4vw, 2rem);
  max-width: 48rem;
  margin-inline: auto;
  padding: calc(1rem + env(safe-area-inset-top)) max(var(--gutter), env(safe-area-inset-right))
    calc(2rem + env(safe-area-inset-bottom)) max(var(--gutter), env(safe-area-inset-left));
  overflow-wrap: anywhere;
}
.brand, h3, .count {
  font-size: .75rem;
  line-height: 1.4;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
}
.brand { display: flex; align-items: center; gap: .55rem; color: var(--soft); }
.brand::before {
  content: "";
  width: .75rem;
  height: .75rem;
  border: 2px solid var(--cyan);
  border-radius: 50%;
}
h1, h2 { line-height: 1.25; font-weight: 600; letter-spacing: -.015em; }
h1 { margin: .5rem 0 1rem; font-size: clamp(1.4rem, 3vw, 2rem); }
h2 { margin: 0; font-size: clamp(1.125rem, 2.5vw, 1.375rem); }
h3 { margin: 1.25rem 0 .3rem; color: var(--cyan); }
p, dl { margin: .5rem 0; }
.count { margin: -.5rem 0 1rem; color: var(--muted); }
.muted, dd { color: var(--soft); }
dt { font-weight: 600; }
dd { margin: 0 0 .5rem; }
.review-context { margin: 0 0 1rem; padding-inline-start: .875rem; border-inline-start: 2px solid var(--cyan-edge); }
.review-context dt { color: var(--text); }
.card-reference { margin: 1rem 0; color: var(--soft); font-size: .875rem; }
.preserve, pre { white-space: pre-wrap; }
article, .empty {
  margin: 0 0 1rem;
  padding: clamp(.875rem, 3.25vw, 1.5rem);
  border: 1px solid var(--line);
  border-radius: .625rem;
  background: linear-gradient(150deg, #121821, #0a0e14);
}
.inbox-review { border-color: var(--cyan-edge); box-shadow: inset 3px 0 var(--amber); }
.inbox-review ul { padding-inline-start: 1.25rem; margin: .625rem 0 1rem; color: var(--soft); }
.inbox-review li + li { margin-top: .4rem; }
.inbox-review li::marker { color: var(--amber); }
.empty { display: flex; align-items: center; gap: .75rem; border-color: var(--cyan-edge); }
.check {
  display: grid;
  place-items: center;
  flex: none;
  width: 1.75rem;
  height: 1.75rem;
  border: 1px solid currentColor;
  border-radius: 50%;
  color: var(--green);
}
figure { margin: 1rem 0; }
figcaption { margin-bottom: .4rem; font-weight: 600; color: var(--soft); }
pre {
  padding: .75rem;
  margin: 0;
  border: 1px solid var(--line);
  border-radius: .5rem;
  background: var(--canvas);
  font: .875rem/1.5 ui-monospace, Consolas, monospace;
  overflow-wrap: anywhere;
}
img { display: block; max-width: 100%; max-height: 36rem; object-fit: contain; border-radius: .5rem; }
fieldset { min-inline-size: 0; padding: 0; margin: 1.25rem 0; border: 0; }
legend { max-width: 100%; padding: 0; font-weight: 600; }
label { display: block; }
.option {
  display: flex;
  align-items: flex-start;
  gap: .625rem;
  min-height: 44px;
  margin: .375rem 0;
  padding: .625rem .75rem;
  border: 1px solid var(--line);
  border-radius: .5rem;
  cursor: pointer;
}
.option:has(:checked) { border-color: var(--cyan); background: var(--cyan-tint); }
.option input { flex: none; width: 1.125rem; height: 1.125rem; margin: .2rem 0 0; accent-color: var(--cyan); }
.option span { min-width: 0; }
textarea, select {
  display: block;
  width: 100%;
  min-height: 44px;
  margin: .375rem 0 0;
  padding: .55rem .625rem;
  border: 1px solid var(--field-edge);
  border-radius: .5rem;
  color: var(--text);
  background: var(--canvas);
  font: inherit;
}
textarea { resize: vertical; }
.ratings { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: .875rem; margin: 1rem 0; }
.ratings label { min-width: 0; }
details { border-top: 1px solid var(--line); }
summary { min-height: 44px; padding: .65rem 0; color: var(--soft); font-weight: 600; cursor: pointer; }
summary::marker { color: var(--cyan); }
button {
  min-height: 44px;
  max-width: 100%;
  padding: .625rem 1.125rem;
  border: 1px solid var(--cyan);
  border-radius: .625rem;
  color: var(--cyan);
  background: var(--cyan-tint);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
details button { margin-top: .75rem; color: var(--soft); border-color: var(--field-edge); background: var(--panel); }
a { display: inline-flex; align-items: center; min-height: 44px; color: var(--cyan); text-underline-offset: .2em; }
:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
.receipt, .error, [role="status"] { padding: .75rem 1rem; border: 1px solid var(--cyan-edge); border-radius: .5rem; background: var(--panel); }
.receipt { border-inline-start: 3px solid var(--green); }
.error { border-inline-start: 3px solid var(--red); }
[role="status"] { border-inline-start: 3px solid var(--amber); }
@media (max-width: 36rem) {
  button { width: 100%; }
}
@media (hover: hover) {
  button:hover, .option:hover { border-color: var(--cyan); background: #38d6ff1c; }
  a:hover, summary:hover { color: var(--text); }
}
`;
