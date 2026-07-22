export const researchCategories = [
  "Agriculture and Environment",
  "Business and Economics",
  "Education",
  "Engineering and Technology",
  "Health Sciences",
  "Humanities and Social Sciences",
  "Information and Computing",
  "Natural Sciences",
  "Multidisciplinary",
] as const;

export const sustainableDevelopmentGoals = [
  "No Poverty",
  "Zero Hunger",
  "Good Health and Well-Being",
  "Quality Education",
  "Gender Equality",
  "Clean Water and Sanitation",
  "Affordable and Clean Energy",
  "Decent Work and Economic Growth",
  "Industry, Innovation and Infrastructure",
  "Reduced Inequalities",
  "Sustainable Cities and Communities",
  "Responsible Consumption and Production",
  "Climate Action",
  "Life Below Water",
  "Life on Land",
  "Peace, Justice and Strong Institutions",
  "Partnerships for the Goals",
] as const;

export function taxonomyPrompt(field: string): string {
  if (field === "category") return `Infer the single best-supported research domain from the document's purpose, subject, and methods. The category label need not appear verbatim. Choose exactly one of: ${researchCategories.join("; ")}. Return an empty value only when no category has materially stronger evidence than the others.`;
  if (field === "suggested_sdgs") {
    return `Infer up to three goals that the documented purpose, methods, or intended outcomes directly advance; goal names need not appear verbatim. For example, substantive water quality or sanitation work can support Goal 6, while documented health outcomes can support Goal 3. Return an empty list when support is merely a superficial keyword. Valid goals are: ${sustainableDevelopmentGoals.map((name, index) => `${index + 1} ${name}`).join("; ")}.`;
  }
  return "";
}
