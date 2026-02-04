#!/usr/bin/env bun
import { Command } from 'commander';
import { text, isCancel, cancel, intro, outro } from '@clack/prompts';
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
  .command('deploy [handle]', { isDefault: true })
  .description('Deploy a static site to wisp.place')
  .option('-p, --path <path>', 'Directory to deploy')
  .option('-s, --site <name>', 'Site name (defaults to directory name)')
  .option('--directory', 'Enable directory listing')
  .option('--spa', 'Enable SPA mode (serve index.html for all routes)')
  .option('-c, --concurrency <n>', 'Number of concurrent uploads (backs off to 2 on rate limit)', '3')
  .option('--password <password>', 'App password for headless authentication')
  .option('--store <path>', 'OAuth session store path')
  .option('-y, --yes', 'Skip confirmation prompts')
  .action(async (handle: string | undefined, options) => {
    try {
      let resolvedHandle = handle;
      let resolvedPath = options.path;
      let resolvedSite = options.site;

      // If any required values are missing, show prompts
      const needsPrompts = !resolvedHandle || !resolvedPath || !resolvedSite;

      if (needsPrompts) {
        intro(pc.cyan('wisp.place deploy'));

        // Prompt for handle if not provided
        if (!resolvedHandle) {
          const handleResult = await text({
            message: 'AT Protocol handle',
            placeholder: 'alice.bsky.social',
            validate: (value) => {
              if (!value) return 'Handle is required';
              if (!value.includes('.')) return 'Handle must include a domain (e.g., alice.bsky.social)';
            }
          });

          if (isCancel(handleResult)) {
            cancel('Deploy cancelled');
            process.exit(0);
          }
          resolvedHandle = handleResult;
        }

        // Prompt for path if not provided
        if (!resolvedPath) {
          const pathResult = await text({
            message: 'Directory to deploy',
            placeholder: '.',
            defaultValue: '.'
          });

          if (isCancel(pathResult)) {
            cancel('Deploy cancelled');
            process.exit(0);
          }
          resolvedPath = pathResult || '.';
        }

        // Prompt for site name if not provided
        if (!resolvedSite) {
          const siteResult = await text({
            message: 'Site name',
            placeholder: 'my-website',
            validate: (value) => {
              if (!value) return 'Site name is required';
              if (!/^[a-zA-Z0-9._~:-]{1,512}$/.test(value)) {
                return 'Site name must be 1-512 characters of [a-zA-Z0-9._~:-]';
              }
            }
          });

          if (isCancel(siteResult)) {
            cancel('Deploy cancelled');
            process.exit(0);
          }
          resolvedSite = siteResult;
        }
      }

      const { agent, did } = await authenticate(resolvedHandle!, {
        appPassword: options.password,
        storePath: options.store
      });

      const result = await deploy(agent, did, {
        path: resolvedPath,
        site: resolvedSite,
        directory: options.directory,
        spa: options.spa,
        yes: options.yes,
        concurrency: parseInt(options.concurrency, 10)
      });

      console.log();
      console.log(pc.dim(`  URI: ${result.uri}`));
      console.log(pc.cyan(`  URL: ${result.url}`));

      if (needsPrompts) {
        outro(pc.green('Deployed successfully!'));
      } else {
        console.log();
        console.log(pc.green('✓ Deployed successfully!'));
      }
      process.exit(0);
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
