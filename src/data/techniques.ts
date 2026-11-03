/**
 * ISTQB test design techniques (Foundation Level syllabus v4.0 names).
 * Generated test data is tagged with the technique it applies, so the bug
 * report can say how the defect was found.
 */
export const ISTQB_TECHNIQUES = {
  'equivalence-partitioning': { name: 'Equivalence partitioning', category: 'black-box' },
  'boundary-value-analysis': { name: 'Boundary value analysis', category: 'black-box' },
  'decision-table-testing': { name: 'Decision table testing', category: 'black-box' },
  'state-transition-testing': { name: 'State transition testing', category: 'black-box' },
  'error-guessing': { name: 'Error guessing', category: 'experience-based' },
  'exploratory-testing': { name: 'Exploratory testing', category: 'experience-based' },
  'checklist-based-testing': { name: 'Checklist-based testing', category: 'experience-based' },
  'use-case-testing': { name: 'Use case testing', category: 'black-box' },
  'random-testing': { name: 'Random testing', category: 'black-box' },
} as const;

export type TechniqueId = keyof typeof ISTQB_TECHNIQUES;

export function techniqueName(id: TechniqueId): string {
  return ISTQB_TECHNIQUES[id].name;
}
