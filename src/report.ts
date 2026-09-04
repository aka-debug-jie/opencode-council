export const REPORT_SECTIONS = ["Participant findings", "Agreements", "Disagreements", "Risks", "Falsification tests", "Unresolved questions"] as const
export function validateCouncilReport(text: string): string {
  const value = text.trim()
  const headings = [...value.matchAll(/^#{1,3} .+$/gm)]
  const expected = ["## Council Report", ...REPORT_SECTIONS.map(s => "### " + s)]
  if (!value.startsWith("## Council Report\n") || headings.length !== expected.length
    || headings.some((m,i) => m[0].trimEnd() !== expected[i])) throw new Error("Council Report requires exactly six ordered sections")
  for (let i=1;i<headings.length;i++) {
    if (!value.slice(headings[i].index! + headings[i][0].length, headings[i+1]?.index ?? value.length).trim()) throw new Error("Council Report sections must be nonempty")
  }
  return value
}
