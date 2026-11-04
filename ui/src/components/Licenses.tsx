// Help → Licences: Filum's own licence and every third-party component it
// ships (embroidery fonts, outline fonts, ported code, npm packages, Rust
// crates) with full licence texts. Data: public/licenses/third-party.json
// (scripts/gen-licenses.mjs) and public/embroidery-fonts (scripts/bundle-fonts.mjs).

import { ChevronDown, ChevronRight, ExternalLink, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { embroideryIndex, embroideryLicense, type EmbroideryIndex } from "../lib/fonts";
import { Dialog, ExtLink } from "./ui";

interface Item {
  name: string;
  version: string;
  license: string;
  author: string;
  url: string;
  note?: string;
  files: { file: string; text: string | null }[];
}
interface ThirdParty {
  generated: string;
  /** licence text id (see texts) */
  app: { license: string; text: string };
  ported: Item[];
  fonts: Item[];
  npm: Item[];
  cargo: Item[];
  texts: Record<string, string>;
}

type Tab = "app" | "embroidery" | "fonts" | "ported" | "npm" | "cargo";

let dataP: Promise<ThirdParty> | null = null;
const thirdParty = () => {
  if (!dataP) {
    dataP = fetch("/licenses/third-party.json").then((r) => r.json() as Promise<ThirdParty>);
    dataP.catch(() => (dataP = null));
  }
  return dataP;
};

/** Embroidery fonts as licence items; texts load when a row is opened. */
const fontItems = (ix: EmbroideryIndex): (Item & { fontId: string; download?: string })[] =>
  ix.fonts.map((f) => ({
    fontId: f.id,
    download: f.download,
    name: f.name,
    version: f.download ? "optional download · not included" : "",
    license: f.license,
    author: f.original ? `Based on ${f.original}` : "",
    url: f.url,
    note: f.description,
    files: [],
  }));

function Row({ item, texts, loadText }: { item: Item; texts: Record<string, string>; loadText?: () => Promise<string> }) {
  const [open, setOpen] = useState(false);
  const [lazy, setLazy] = useState<string | null>(null);
  useEffect(() => {
    if (open && loadText && lazy === null) loadText().then((t) => setLazy(t || "No licence file is included with this font; see its stated licence."));
  }, [open, loadText, lazy]);
  return (
    <div className={`lic-row ${open ? "open" : ""}`}>
      <button className="lic-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <b>{item.name}</b>
        {item.version && <span className="lic-ver">{item.version}</span>}
        <span className="lic-spacer" />
        <span className="lic-badge">{item.license}</span>
      </button>
      {open && (
        <div className="lic-body">
          {(item.author || item.url || item.note) && (
            <p className="lic-meta">
              {item.note && <span>{item.note}</span>}
              {item.author && <span>{item.author}</span>}
              {item.url && (
                <ExtLink href={item.url}>
                  {item.url.replace(/^https?:\/\//, "")} <ExternalLink size={10} />
                </ExtLink>
              )}
            </p>
          )}
          {loadText ? (
            <pre>{lazy ?? "Loading…"}</pre>
          ) : item.files.length ? (
            item.files.map((f) => (
              <div key={f.file}>
                {item.files.length > 1 && <h4>{f.file}</h4>}
                <pre>{f.text ? texts[f.text] : ""}</pre>
              </div>
            ))
          ) : (
            <pre>Licensed under {item.license}.</pre>
          )}
        </div>
      )}
    </div>
  );
}

export function LicensesDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<ThirdParty | null>(null);
  const [fonts, setFonts] = useState<EmbroideryIndex | null>(null);
  const [tab, setTab] = useState<Tab>("app");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    thirdParty()
      .then(setData)
      .catch((e) => setError(String(e)));
    embroideryIndex()
      .then(setFonts)
      .catch(() => {});
  }, []);
  const embroidery = useMemo(() => (fonts ? fontItems(fonts) : []), [fonts]);
  const lists: Record<Exclude<Tab, "app">, Item[]> = {
    embroidery,
    fonts: data?.fonts ?? [],
    ported: data?.ported ?? [],
    npm: data?.npm ?? [],
    cargo: data?.cargo ?? [],
  };
  const tabs: [Tab, string][] = [
    ["app", "Filum"],
    ["embroidery", `Embroidery fonts (${embroidery.length})`],
    ["fonts", `Fonts (${lists.fonts.length})`],
    ["ported", "Ported code"],
    ["npm", `JavaScript (${lists.npm.length})`],
    ["cargo", `Rust (${lists.cargo.length})`],
  ];
  const q = query.trim().toLowerCase();
  const items =
    tab === "app"
      ? []
      : lists[tab].filter((i) => !q || i.name.toLowerCase().includes(q) || i.license.toLowerCase().includes(q) || i.author.toLowerCase().includes(q));
  // licence summary of the current list
  const summary = useMemo(() => {
    if (tab === "app") return "";
    const n = new Map<string, number>();
    for (const i of lists[tab]) n.set(i.license, (n.get(i.license) ?? 0) + 1);
    return [...n.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([l, c]) => `${l} ×${c}`)
      .join(" · ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, data, embroidery]);

  return (
    <Dialog wide title="Licences" onClose={onClose}>
      <div className="font-tabs">
        <div className="seg lic-tabs">
          {tabs.map(([id, label]) => (
            <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        {tab !== "app" && (
          <label className="ctx-field" style={{ flex: 1, minWidth: 160 }}>
            <Search size={13} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" style={{ width: "100%", textAlign: "left" }} />
          </label>
        )}
      </div>
      {error && <p className="hint warn">Could not load the licence list: {error}</p>}
      {tab === "app" ? (
        <div className="lic-app">
          <p>
            Filum is free software: you can redistribute it and/or modify it under the terms of the <b>GNU General Public License</b> as published
            by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It includes algorithms ported
            from Ink/Stitch (GPL-3.0) and its file library pystitch (MIT); the other tabs list every font, library and crate shipped with the app and their licences.
          </p>
          <p className="hint">
            Embroidery fonts come from the Ink/Stitch community collection
            {fonts?.commit ? ` (${fonts.source} @ ${fonts.commit.slice(0, 7)})` : ""}. Fonts may carry their own terms (most are SIL OFL 1.1) —
            check a font's licence before selling designs made with it.
            {data ? ` Licence list generated ${data.generated}.` : ""}
          </p>
          <pre className="lic-full">{data ? data.texts[data.app.text] ?? "" : "Loading…"}</pre>
        </div>
      ) : (
        <>
          <p className="hint" style={{ padding: "6px 2px" }}>
            {tab === "embroidery" && "Every Ink/Stitch embroidery font with the licence file shipped by its author. Fonts marked optional download aren't included with Filum; you can download them in Preferences → Downloads. "}
            {tab === "fonts" && "Outline fonts bundled for lettering. "}
            {tab === "ported" && "Projects whose code or data Filum's engine is derived from. "}
            {tab === "npm" && "JavaScript packages in the app's user interface. "}
            {tab === "cargo" && "Rust crates compiled into the stitch engine and the desktop app (all platforms). "}
            {summary}
          </p>
          <div className="lic-list">
            {items.map((i) => (
              <Row
                key={`${i.name}@${i.version}`}
                item={i}
                texts={data?.texts ?? {}}
                loadText={
                  "fontId" in i
                    ? () =>
                        embroideryLicense((i as { fontId: string }).fontId).then(
                          (t) => t || ((i as { download?: string }).download ? `Not included with Filum: its licence (${i.license}) doesn't allow it. Download it in Preferences → Downloads to see the author's licence file here.` : ""),
                        )
                    : undefined
                }
              />
            ))}
            {!items.length && <p className="hint">{data || tab === "embroidery" ? "Nothing found." : "Loading…"}</p>}
          </div>
        </>
      )}
    </Dialog>
  );
}
