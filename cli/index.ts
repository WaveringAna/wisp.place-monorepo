#!/usr/bin/env bun
import { Command } from 'commander';
import { authenticate, clearSessions } from './lib/auth.ts';
import { deploy } from './commands/deploy.ts';
import { pull } from './commands/pull.ts';
import { serve } from './commands/serve.ts';
import { pc } from './lib/progress.ts';

const program = new Command();

program
  .name('wisp-cli')
  .description('CLI for wisp.place - deploy static sites to the AT Protocol')
  .version('1.0.0');

// Deploy command (default)
program
  .command('deploy <handle>', { isDefault: true })
  .description('Deploy a static site to wisp.place')
  .option('-p, --path <path>', 'Directory to deploy', '.')
  .option('-s, --site <name>', 'Site name (defaults to directory name)')
  .option('--directory', 'Enable directory listing')
  .option('--spa', 'Enable SPA mode (serve index.html for all routes)')
  .option('--password <password>', 'App password for headless authentication')
  .option('--store <path>', 'OAuth session store path')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(async (handle: string, options) => {
    try {
      const { agent, did } = await authenticate(handle, {
        appPassword: options.password,
        storePath: options.store
      });

      await deploy(agent, did, {
        path: options.path,
        site: options.site,
        directory: options.directory,
        spa: options.spa,
        yes: options.yes
      });
    } catch (err: any) {
      console.error(pc.red(`\nError: ${err.message}\n`));
      process.exit(1);
    }
  });

// Pull command
program
  .command('pull <handle>')
  .description('Download a site from wisp.place to a local directory')
  .requiredOption('-s, --site <name>', 'Site name to pull')
  .option('-p, --path <path>', 'Output directory', '.')
  .action(async (handle: string, options) => {
    try {
      await pull(handle, {
        site: options.site,
        path: options.path
      });
    } catch (err: any) {
      console.error(pc.red(`\nError: ${err.message}\n`));
      process.exit(1);
    }
  });

// Serve command
program
  .command('serve <handle>')
  .description('Serve a site locally with live updates from firehose')
  .requiredOption('-s, --site <name>', 'Site name to serve')
  .option('-p, --path <path>', 'Local directory to cache site', '.wisp-serve')
  .option('-P, --port <port>', 'Port to serve on', '8080')
  .action(async (handle: string, options) => {
    try {
      await serve(handle, {
        site: options.site,
        path: options.path,
        port: parseInt(options.port, 10)
      });
    } catch (err: any) {
      console.error(pc.red(`\nError: ${err.message}\n`));
      process.exit(1);
    }
  });

// Logout command
program
  .command('logout')
  .description('Clear stored OAuth sessions')
  .option('--store <path>', 'OAuth session store path')
  .action((options) => {
    clearSessions(options.store);
  });

program.parse();
