import { defineLexiconConfig } from '@atcute/lex-cli';

export default defineLexiconConfig({
  files: ['../../../lexicons/*-v2.json'],
  outdir: 'src/atcute/lexicons',
});
