#!/usr/bin/env node
/**
 * Straico API Documentation Updater
 * Fetches the latest API docs from Postman and updates local documentation
 * 
 * Usage:
 *   node scripts/update-api-docs.js [--check]
 *   
 * Options:
 *   --check    Only check if updates are available, don't update
 *   --json     Output as JSON instead of markdown
 */

import fs from 'fs';
import path from 'path';

const COLLECTION_URL = 'https://documenter.gw.postman.com/api/collections/5900072/2s9YyzddrR?segregateAuth=true&versionTag=latest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DOCS_DIR = join(__dirname, '../docs/straico-api');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// Parse arguments
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const outputJson = args.includes('--json');

async function updateDocs() {
  console.log('🔄 Straico API Documentation Updater');
  console.log('====================================\n');

  // Ensure docs directory exists
  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
  }

  // Fetch latest collection
  console.log('📡 Fetching latest collection from Postman...');
  let newData;
  try {
    const response = await fetch(COLLECTION_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    newData = await response.json();
  } catch (error) {
    console.error(`❌ Failed to fetch collection: ${error.message}`);
    process.exit(1);
  }

  // Calculate endpoint count
  let newEndpointCount = 0;
  newData.item.forEach(folder => {
    newEndpointCount += folder.item?.length || 0;
  });

  console.log(`✅ Fetched collection: ${newEndpointCount} endpoints\n`);

  // Check if existing docs exist and compare
  const currentMdPath = path.join(DOCS_DIR, 'straico-api.md');
  const currentJsonPath = path.join(DOCS_DIR, 'straico-api.json');

  let hasChanges = true;
  let oldEndpointCount = 0;

  if (fs.existsSync(currentJsonPath)) {
    try {
      const oldData = JSON.parse(fs.readFileSync(currentJsonPath, 'utf8'));
      oldEndpointCount = oldData.endpoints?.length || 0;
      
      // Compare by checking if endpoints have changed
      const oldEndpoints = JSON.stringify(oldData.endpoints?.map(e => `${e.method} ${e.url}`).sort());
      const newEndpoints = JSON.stringify(
        newData.item.flatMap(folder => 
          folder.item?.map(e => {
            const req = e.request;
            const url = typeof req?.url === 'string' ? req.url : req?.url?.raw || '';
            return `${req?.method || 'GET'} ${url}`;
          }) || []
        ).sort()
      );
      
      hasChanges = oldEndpoints !== newEndpoints;
      
      if (!hasChanges) {
        console.log('ℹ️  No changes detected in the API documentation.');
        console.log(`   Current: ${oldEndpointCount} endpoints`);
        console.log(`   Latest:  ${newEndpointCount} endpoints\n`);
        
        if (checkOnly) {
          process.exit(0);
        }
        
        const answer = await askQuestion('   Update anyway? (y/N): ');
        if (answer.toLowerCase() !== 'y') {
          console.log('   Skipping update.\n');
          process.exit(0);
        }
        hasChanges = true;
      } else {
        const diff = newEndpointCount - oldEndpointCount;
        const diffText = diff > 0 ? `+${diff} new` : `${diff} removed`;
        console.log(`📝 Changes detected: ${diffText} endpoints`);
        console.log(`   Previous: ${oldEndpointCount} endpoints`);
        console.log(`   Current:  ${newEndpointCount} endpoints\n`);
      }
    } catch (error) {
      console.log('⚠️  Could not compare with existing docs, will update anyway\n');
    }
  } else {
    console.log('🆕 No existing documentation found. Creating new docs.\n');
  }

  if (checkOnly) {
    console.log('✨ Check complete. Run without --check to update.');
    process.exit(0);
  }

  // Backup old files if they exist
  if (fs.existsSync(currentMdPath)) {
    const backupMd = path.join(DOCS_DIR, `straico-api-${TIMESTAMP}.md.backup`);
    fs.copyFileSync(currentMdPath, backupMd);
    console.log(`💾 Backed up old markdown to: ${path.basename(backupMd)}`);
  }

  if (fs.existsSync(currentJsonPath)) {
    const backupJson = path.join(DOCS_DIR, `straico-api-${TIMESTAMP}.json.backup`);
    fs.copyFileSync(currentJsonPath, backupJson);
    console.log(`💾 Backed up old JSON to: ${path.basename(backupJson)}`);
  }

  // Rotate old backups (keep last 10)
  const MAX_BACKUPS = 4;
  const backups = fs.readdirSync(DOCS_DIR)
    .filter(f => f.endsWith('.backup'))
    .sort();

  if (backups.length > MAX_BACKUPS) {
    const toDelete = backups.slice(0, backups.length - MAX_BACKUPS);
    console.log(`\n🗑️  Removing ${toDelete.length} old backup(s) (keeping last ${MAX_BACKUPS})...`);
    toDelete.forEach(b => {
      fs.unlinkSync(path.join(DOCS_DIR, b));
      console.log(`   - ${b}`);
    });
  }

  // Generate markdown
  if (!outputJson) {
    console.log('\n📝 Generating Markdown...');
    const markdown = generateMarkdown(newData, newEndpointCount);
    fs.writeFileSync(currentMdPath, markdown);
    console.log(`✅ Markdown saved: ${currentMdPath}`);
  }

  // Generate JSON
  console.log('📝 Generating JSON...');
  const jsonData = generateJson(newData, newEndpointCount);
  fs.writeFileSync(currentJsonPath, JSON.stringify(jsonData, null, 2));
  console.log(`✅ JSON saved: ${currentJsonPath}`);

  // Save raw collection
  const rawPath = path.join(DOCS_DIR, 'straico-api-raw.json');
  fs.writeFileSync(rawPath, JSON.stringify(newData, null, 2));
  console.log(`✅ Raw collection saved: ${rawPath}`);

  // Generate summary
  console.log('\n📊 Summary:');
  console.log('==========');
  console.log(`Total Endpoints: ${newEndpointCount}`);
  console.log('\nBy Category:');
  newData.item.forEach(folder => {
    const count = folder.item?.length || 0;
    if (count > 0) {
      console.log(`  📁 ${folder.name}: ${count} endpoints`);
    }
  });

  console.log('\n📁 Generated files:');
  if (!outputJson) {
    console.log(`  - ${currentMdPath}`);
  }
  console.log(`  - ${currentJsonPath}`);
  console.log(`  - ${rawPath}`);

  // List backups (reusing the sorted backups array from rotation)
  if (backups.length > 0) {
    console.log(`\n🗂️  Backups (${backups.length}):`);
    [...backups].reverse().slice(0, 5).forEach(b => {
      const stats = fs.statSync(path.join(DOCS_DIR, b));
      console.log(`  - ${b} (${formatBytes(stats.size)})`);
    });
    if (backups.length > 5) {
      console.log(`  ... and ${backups.length - 5} more`);
    }
  }

  console.log('\n✨ Update complete!');
}

function generateMarkdown(data, totalEndpoints) {
  let md = `# ${data.info.name}\n\n`;
  md += `> Last updated: ${new Date().toLocaleString()}\n\n`;
  md += `${convertHtmlToMarkdown(data.info.description)}\n\n`;
  md += '## Base URL\n\n';
  md += '```\nhttps://api.straico.com\n```\n\n';
  md += `## API Endpoints (${totalEndpoints})\n\n`;

  let endpointNum = 1;

  data.item.forEach(folder => {
    if (!folder.item || folder.item.length === 0) return;
    
    md += `### 📁 ${folder.name}\n\n`;
    
    folder.item.forEach(endpoint => {
      const req = endpoint.request;
      const method = req?.method || 'GET';
      const url = typeof req?.url === 'string' ? req.url : req?.url?.raw || '';
      const name = endpoint.name;
      
      md += `#### ${endpointNum}. ${name}\n\n`;
      md += `**${method}** \`${url}\`\n\n`;
      
      if (req?.description) {
        const desc = convertHtmlToMarkdown(req.description);
        if (desc) {
          md += `${desc}\n\n`;
        }
      }
      
      // Headers
      if (req?.header && req.header.length > 0) {
        md += '**Headers:**\n\n';
        md += '| Key | Value |\n';
        md += '|-----|-------|\n';
        req.header.forEach(h => {
          md += `| ${h.key} | ${h.value} |\n`;
        });
        md += '\n';
      }
      
      // Request body
      if (req?.body?.mode === 'raw' && req.body.raw) {
        md += '**Request Body:**\n\n';
        md += `\`\`\`json\n${req.body.raw}\n\`\`\`\n\n`;
      }
      
      // Responses
      if (endpoint.response && endpoint.response.length > 0) {
        endpoint.response.forEach((resp) => {
          md += `**Response ${resp.code || 200} ${resp.status || 'OK'}:**\n\n`;
          if (resp.body) {
            md += `\`\`\`json\n${resp.body}\n\`\`\`\n\n`;
          }
        });
      }
      
      md += '---\n\n';
      endpointNum++;
    });
  });

  return md;
}

/**
 * Convert HTML to Markdown, properly handling tables
 * @param {string} html - HTML content
 * @returns {string} Markdown content
 */
function convertHtmlToMarkdown(html) {
  if (!html) return '';
  
  let md = html;
  
  // Convert tables first (before stripping other tags)
  // Extract table data
  md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (match, tableContent) => {
    let tableMd = '\n';
    
    // Extract headers
    const headers = [];
    tableContent.replace(/<th[^>]*>([\s\S]*?)<\/th>/gi, (match, th) => {
      headers.push(stripHtml(th).trim());
      return '';
    });
    
    // Extract rows
    const rows = [];
    tableContent.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (match, tr) => {
      const cells = [];
      tr.replace(/<td[^>]*>([\s\S]*?)<\/td>/gi, (match, td) => {
        cells.push(stripHtml(td).trim());
        return '';
      });
      if (cells.length > 0) {
        rows.push(cells);
      }
      return '';
    });
    
    // Build markdown table
    if (headers.length > 0) {
      tableMd += '| ' + headers.join(' | ') + ' |\n';
      tableMd += '|' + headers.map(() => ' --- |').join('') + '\n';
    }
    
    rows.forEach(row => {
      tableMd += '| ' + row.join(' | ') + ' |\n';
    });
    
    return tableMd;
  });
  
  // Handle other HTML elements
  md = md
    // Headers
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
    // Code blocks
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    // Lists
    .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (match, list) => {
      return list.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
    })
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (match, list) => {
      let idx = 1;
      return list.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, () => `${idx++}. $1\n`);
    })
    // Paragraphs and breaks
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Bold and italic
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
    // Links
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    // Remove remaining tags
    .replace(/<[^>]*>/g, '')
    // Clean up whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  
  return md;
}

/**
 * Strip HTML tags from text
 * @param {string} html - HTML content
 * @returns {string} Plain text
 */
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').trim();
}

function generateJson(data, totalEndpoints) {
  const cleanData = {
    info: {
      name: data.info.name,
      description: convertHtmlToMarkdown(data.info.description),
      baseUrl: 'https://api.straico.com',
      lastUpdated: new Date().toISOString(),
      totalEndpoints: totalEndpoints
    },
    folders: []
  };

  data.item.forEach(folder => {
    if (!folder.item || folder.item.length === 0) return;
    
    const folderData = {
      name: folder.name,
      description: convertHtmlToMarkdown(folder.description) || '',
      endpointCount: folder.item.length,
      endpoints: []
    };

    folder.item.forEach(endpoint => {
      const req = endpoint.request;
      folderData.endpoints.push({
        name: endpoint.name,
        method: req?.method || 'GET',
        url: typeof req?.url === 'string' ? req.url : req?.url?.raw || '',
        description: convertHtmlToMarkdown(req?.description) || '',
        headers: req?.header || [],
        body: req?.body?.mode === 'raw' ? req.body.raw : null,
        responses: endpoint.response?.map(r => ({
          status: r.code || 200,
          statusText: r.status || 'OK',
          body: r.body
        })) || []
      });
    });

    cleanData.folders.push(folderData);
  });

  return cleanData;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function askQuestion(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    process.stdin.once('data', data => {
      resolve(data.toString().trim());
    });
  });
}

// Run updater
updateDocs().catch(error => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
