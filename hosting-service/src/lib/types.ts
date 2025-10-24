import type { BlobRef } from '@atproto/api';

export interface WispFsRecord {
  $type: 'place.wisp.fs';
  site: string;
  root: Directory;
  fileCount?: number;
  createdAt: string;
}

export interface File {
  $type?: 'place.wisp.fs#file';
  type: 'file';
  blob: BlobRef;
}

export interface Directory {
  $type?: 'place.wisp.fs#directory';
  type: 'directory';
  entries: Entry[];
}

export interface Entry {
  $type?: 'place.wisp.fs#entry';
  name: string;
  node: File | Directory | { $type: string };
}
