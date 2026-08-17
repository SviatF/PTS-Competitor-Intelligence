export type CollectedAd = {
  source: 'META' | 'GOOGLE';
  externalId?: string;
  fingerprint: string;
  format?: 'IMAGE' | 'VIDEO' | 'CAROUSEL' | 'UNKNOWN';
  primaryText?: string;
  headline?: string;
  cta?: string;
  landingUrl?: string;
  creativeUrl?: string;
  adLibraryUrl?: string;
  raw: Record<string, unknown>;
};

export type CollectorCompetitor = {
  id: string;
  name: string;
  website?: string | null;
  metaAdLibraryUrl?: string | null;
};

export interface AdCollector {
  collect(competitor: CollectorCompetitor): Promise<CollectedAd[]>;
}
