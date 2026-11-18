/*! Open Historia — the public accounts update notice. AGPL-3.0-or-later (see LICENSE). */
import React from "react";
import { Brackets, FeatureCards, Plate, Reveal, Rule, noticeDate } from "../updateKit.jsx";

const brass = "#d4bc87";
export default function Cabinet({ banner, update }) {
  return <Plate surface={{ background: "#172923", color: "#f5ecd9" }}>
    <Brackets colour={brass} />
    <div style={{ padding: "clamp(1rem, 4vw, 2.4rem)", maxWidth: 850, margin: "auto" }}>
      <Reveal delay={80}>
        <div aria-hidden="true" style={{ display: "flex", justifyContent: "center", gap: 5, alignItems: "end", height: 28 }}>
          {[11, 17, 22, 26, 22, 17, 11].map((height, index) => <i key={index} style={{ height, width: 7, borderTop: "3px solid #f1deb4", backgroundColor: "#748e76" }} />)}
        </div>
        <Rule colour={brass} margin=".5rem 0" />
        <div style={{ textAlign: "center", color: brass, fontVariantNumeric: "tabular-nums" }}>{noticeDate(update.date)}</div>
        <h2 style={{ fontFamily: "Georgia, serif", textAlign: "center", fontSize: "clamp(1.65rem, 5vw, 3rem)", margin: ".15em 0" }}>{banner.title}</h2>
        <p style={{ textAlign: "center", maxWidth: 580, margin: ".5rem auto 1rem", lineHeight: 1.5 }}>{banner.lead}</p>
      </Reveal>
      <FeatureCards accent={brass} soft="#dedfcd" sections={banner.sections} columns="repeat(auto-fit, minmax(min(100%, 13rem), 1fr))" />
    </div>
  </Plate>;
}
