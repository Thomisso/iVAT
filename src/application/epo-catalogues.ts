import catalogue from "./epo-catalogues.json";

// Generated from official EPO catalogues retrieved 2026-10-30. See schemas/epo/README.md.
export const TERRITORIAL_OFFICES = catalogue.territorialOffices;
export const ECONOMIC_ACTIVITIES = catalogue.economicActivities;

export const isTerritorialOffice = (taxOffice: string, code: string): boolean =>
  TERRITORIAL_OFFICES.some((office) => office.taxOffice === taxOffice && office.code === code);

export const isEconomicActivity = (code: string): boolean =>
  ECONOMIC_ACTIVITIES.some((activity) => activity.code === code);
