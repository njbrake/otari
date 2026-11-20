import { describe, expect, it } from "vitest"

import {
  DEFAULT_TABLE_LAYOUT,
  isCustomLayout,
  MAX_COLUMN_WIDTH,
  readTableLayout,
  type TableLayoutColumn,
  tableLayoutDocument,
  withoutDefaultWidths,
} from "./tableLayout"

const COLUMNS: TableLayoutColumn[] = [
  { id: "time", label: "Time", isHideable: true, width: 84, minWidth: 64 },
  { id: "model", label: "Model", isHideable: false, minWidth: 120 },
  {
    id: "cost",
    label: "Cost",
    isHideable: true,
    width: 100,
    minWidth: 72,
    maxWidth: 300,
  },
]

describe("readTableLayout", () => {
  it("reads back the document it writes", () => {
    const layout = { widths: { time: 90, model: 300 }, hidden: ["cost"] }
    expect(readTableLayout(tableLayoutDocument(layout), COLUMNS)).toEqual(
      layout,
    )
  })

  it("is the default layout for nothing stored, another version or not an object", () => {
    for (const value of [
      null,
      undefined,
      [],
      "time",
      { widths: { time: 90 } },
      { version: 2, widths: { time: 90 }, hidden: ["cost"] },
    ]) {
      expect(readTableLayout(value, COLUMNS)).toEqual(DEFAULT_TABLE_LAYOUT)
    }
  })

  it("drops what it cannot use and keeps the rest", () => {
    const layout = readTableLayout(
      {
        version: 1,
        widths: {
          time: "wide",
          model: Number.NaN,
          cost: 120.6,
          gone: 200,
        },
        // A column this build has not got, one that may not be hidden, and not a string.
        hidden: ["gone", "model", 7, "time"],
      },
      COLUMNS,
    )
    expect(layout).toEqual({ widths: { cost: 121 }, hidden: ["time"] })
  })

  it("holds each width to its column's bounds", () => {
    const layout = readTableLayout(
      { version: 1, widths: { time: 1, model: 99_999, cost: 900 }, hidden: [] },
      COLUMNS,
    )
    expect(layout.widths).toEqual({
      time: 64,
      model: MAX_COLUMN_WIDTH,
      cost: 300,
    })
  })

  it("lists hidden columns in the table's order, whatever order they were stored in", () => {
    expect(
      readTableLayout({ version: 1, hidden: ["cost", "time"] }, COLUMNS).hidden,
    ).toEqual(["time", "cost"])
  })
})

describe("isCustomLayout", () => {
  it("is false only for the defaults", () => {
    expect(isCustomLayout(DEFAULT_TABLE_LAYOUT)).toBe(false)
    expect(isCustomLayout({ widths: { time: 90 }, hidden: [] })).toBe(true)
    expect(isCustomLayout({ widths: {}, hidden: ["cost"] })).toBe(true)
  })
})

describe("withoutDefaultWidths", () => {
  it("drops widths still at their column's default", () => {
    const columns: TableLayoutColumn[] = [
      { id: "cost", label: "Cost", isHideable: true, width: 104, minWidth: 64 },
      { id: "model", label: "Model", isHideable: true, minWidth: 120 },
    ]
    expect(withoutDefaultWidths({ cost: 104, model: 240 }, columns)).toEqual({
      model: 240,
    })
    expect(withoutDefaultWidths({ cost: 150 }, columns)).toEqual({ cost: 150 })
  })
})
