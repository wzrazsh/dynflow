import { v4 as uuidv4 } from 'uuid';
import { getDb, withRetry } from './connection.js';
import type {
  WorkflowTemplate,
  WorkflowTemplateVersion,
  CreateTemplateRequest,
  UpdateTemplateRequest,
} from '@dynflow/shared';

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

function rowToTemplate(
  row: Record<string, unknown>,
  tags: string[],
): WorkflowTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    script: row.script as string,
    currentVersion: row.current_version as number,
    tags,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToVersion(
  row: Record<string, unknown>,
): WorkflowTemplateVersion {
  return {
    id: row.id as string,
    templateId: row.template_id as string,
    version: row.version as number,
    script: row.script as string,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    createdAt: row.created_at as string,
  };
}

// ---------------------------------------------------------------------------
// Template CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new workflow template.
 * If `tags` are provided in the request, they are inserted as tag associations.
 * Returns the fully assembled template with tags.
 */
export function createTemplate(
  data: CreateTemplateRequest,
): WorkflowTemplate {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  withRetry(() =>
    db
      .prepare(
        `INSERT INTO workflow_templates (id, name, description, script, current_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, data.name, data.description ?? null, data.script, now, now),
  );

  if (data.tags && data.tags.length > 0) {
    const insertTag = db.prepare(
      'INSERT INTO workflow_template_tags (id, template_id, tag) VALUES (?, ?, ?)',
    );
    for (const tag of data.tags) {
      withRetry(() => insertTag.run(uuidv4(), id, tag));
    }
  }

  return getTemplate(id)!;
}

/**
 * Retrieve a single template by ID with its tags.
 * Returns `undefined` if the ID does not exist.
 */
export function getTemplate(id: string): WorkflowTemplate | undefined {
  const db = getDb();
  const row = withRetry(() =>
    db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(id),
  ) as Record<string, unknown> | undefined;
  if (!row) return undefined;

  const tags = getTags(id);
  return rowToTemplate(row, tags);
}

/**
 * List templates with pagination and optional tag filtering.
 * Returns `{ items, total }` where items are the requested page of templates.
 * When `tag` is provided, only templates with that tag are returned.
 */
export function getTemplates(
  page: number,
  pageSize: number,
  tag?: string,
): { items: WorkflowTemplate[]; total: number } {
  const db = getDb();

  let total: number;
  let rows: Record<string, unknown>[];

  if (tag) {
    const countRow = withRetry(() =>
      db
        .prepare(
          'SELECT COUNT(DISTINCT t.id) as count FROM workflow_templates t INNER JOIN workflow_template_tags tt ON t.id = tt.template_id WHERE tt.tag = ?',
        )
        .get(tag),
    ) as { count: number };
    total = countRow.count;

    const offset = (page - 1) * pageSize;
    rows = withRetry(() =>
      db
        .prepare(
          'SELECT DISTINCT t.* FROM workflow_templates t INNER JOIN workflow_template_tags tt ON t.id = tt.template_id WHERE tt.tag = ? ORDER BY t.name ASC LIMIT ? OFFSET ?',
        )
        .all(tag, pageSize, offset),
    ) as Record<string, unknown>[];
  } else {
    const countRow = withRetry(() =>
      db.prepare('SELECT COUNT(*) as count FROM workflow_templates').get(),
    ) as { count: number };
    total = countRow.count;

    const offset = (page - 1) * pageSize;
    rows = withRetry(() =>
      db
        .prepare(
          'SELECT * FROM workflow_templates ORDER BY name ASC LIMIT ? OFFSET ?',
        )
        .all(pageSize, offset),
    ) as Record<string, unknown>[];
  }

  // Batch-fetch tags for all returned template IDs in one query
  const templateIds = rows.map((r) => r.id as string);
  const tagsMap = getTagsForTemplates(templateIds);

  const items = rows.map((row) =>
    rowToTemplate(row, tagsMap.get(row.id as string) ?? []),
  );

  return { items, total };
}

/**
 * Update a template's fields. Only the provided fields are modified.
 * If `tags` is provided, tags are replaced via `setTags()`.
 * Returns the updated template, or `undefined` if the ID does not exist.
 */
export function updateTemplate(
  id: string,
  data: UpdateTemplateRequest,
): WorkflowTemplate | undefined {
  const db = getDb();

  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (data.name !== undefined) {
    setClauses.push('name = ?');
    values.push(data.name);
  }
  if (data.description !== undefined) {
    setClauses.push('description = ?');
    values.push(data.description ?? null);
  }
  if (data.script !== undefined) {
    setClauses.push('script = ?');
    values.push(data.script);
  }

  if (setClauses.length > 0) {
    const now = new Date().toISOString();
    setClauses.push('updated_at = ?');
    values.push(now);
    values.push(id);

    withRetry(() =>
      db
        .prepare(
          `UPDATE workflow_templates SET ${setClauses.join(', ')} WHERE id = ?`,
        )
        .run(...values),
    );
  }

  if (data.tags !== undefined) {
    setTags(id, data.tags);
  }

  return getTemplate(id);
}

/**
 * Delete a template by ID.
 * Versions and tags are removed via CASCADE.
 */
export function deleteTemplate(id: string): void {
  const db = getDb();
  withRetry(() =>
    db.prepare('DELETE FROM workflow_templates WHERE id = ?').run(id),
  );
}

// ---------------------------------------------------------------------------
// Version CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new version of a template.
 * Automatically increments the version number and updates the template's
 * `current_version` and `updated_at` fields.
 */
export function createVersion(
  templateId: string,
  data: { script: string; name: string; description?: string },
): WorkflowTemplateVersion {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  // Determine the next version number
  const latest = getLatestVersion(templateId);
  const version = (latest?.version ?? 0) + 1;

  withRetry(() =>
    db
      .prepare(
        `INSERT INTO workflow_template_versions (id, template_id, version, script, name, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        templateId,
        version,
        data.script,
        data.name,
        data.description ?? null,
        now,
      ),
  );

  // Bump the template's current_version
  withRetry(() =>
    db
      .prepare(
        'UPDATE workflow_templates SET current_version = ?, updated_at = ? WHERE id = ?',
      )
      .run(version, now, templateId),
  );

  return getVersion(id)!;
}

/**
 * List all versions for a template, newest first.
 */
export function getVersions(
  templateId: string,
): WorkflowTemplateVersion[] {
  const db = getDb();
  const rows = withRetry(() =>
    db
      .prepare(
        'SELECT * FROM workflow_template_versions WHERE template_id = ? ORDER BY version DESC',
      )
      .all(templateId),
  ) as Record<string, unknown>[];
  return rows.map(rowToVersion);
}

/**
 * Retrieve a single version by its ID.
 */
export function getVersion(id: string): WorkflowTemplateVersion | undefined {
  const db = getDb();
  const row = withRetry(() =>
    db
      .prepare('SELECT * FROM workflow_template_versions WHERE id = ?')
      .get(id),
  ) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToVersion(row);
}

/**
 * Retrieve the latest version for a template.
 * Returns `undefined` if no versions exist (should not happen in normal use).
 */
export function getLatestVersion(
  templateId: string,
): WorkflowTemplateVersion | undefined {
  const db = getDb();
  const row = withRetry(() =>
    db
      .prepare(
        'SELECT * FROM workflow_template_versions WHERE template_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(templateId),
  ) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToVersion(row);
}

// ---------------------------------------------------------------------------
// Tag CRUD
// ---------------------------------------------------------------------------

/**
 * Add a single tag to a template. No-op if the tag already exists
 * (uses INSERT OR IGNORE due to the UNIQUE constraint).
 */
export function addTag(templateId: string, tag: string): void {
  const db = getDb();
  const id = uuidv4();
  withRetry(() =>
    db
      .prepare(
        'INSERT OR IGNORE INTO workflow_template_tags (id, template_id, tag) VALUES (?, ?, ?)',
      )
      .run(id, templateId, tag),
  );
}

/**
 * Remove a single tag from a template.
 */
export function removeTag(templateId: string, tag: string): void {
  const db = getDb();
  withRetry(() =>
    db
      .prepare(
        'DELETE FROM workflow_template_tags WHERE template_id = ? AND tag = ?',
      )
      .run(templateId, tag),
  );
}

/**
 * Get all tags for a template, sorted alphabetically.
 */
export function getTags(templateId: string): string[] {
  const db = getDb();
  const rows = withRetry(() =>
    db
      .prepare(
        'SELECT tag FROM workflow_template_tags WHERE template_id = ? ORDER BY tag ASC',
      )
      .all(templateId),
  ) as { tag: string }[];
  return rows.map((r) => r.tag);
}

/**
 * Replace all tags for a template.
 * Deletes existing tags and inserts new ones in a single transaction.
 */
export function setTags(templateId: string, tags: string[]): void {
  const db = getDb();

  withRetry(() => {
    const transaction = db.transaction(() => {
      db.prepare(
        'DELETE FROM workflow_template_tags WHERE template_id = ?',
      ).run(templateId);

      const insert = db.prepare(
        'INSERT INTO workflow_template_tags (id, template_id, tag) VALUES (?, ?, ?)',
      );
      for (const tag of tags) {
        insert.run(uuidv4(), templateId, tag);
      }
    });
    transaction();
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Batch-fetch tags for multiple template IDs in a single query.
 * Returns a Map<templateId, string[]> for efficient lookup.
 */
function getTagsForTemplates(
  templateIds: string[],
): Map<string, string[]> {
  if (templateIds.length === 0) return new Map();

  const db = getDb();
  const placeholders = templateIds.map(() => '?').join(', ');
  const rows = withRetry(() =>
    db
      .prepare(
        `SELECT template_id, tag FROM workflow_template_tags WHERE template_id IN (${placeholders}) ORDER BY tag ASC`,
      )
      .all(...templateIds),
  ) as { template_id: string; tag: string }[];

  const map = new Map<string, string[]>();
  for (const row of rows) {
    const existing = map.get(row.template_id) ?? [];
    existing.push(row.tag);
    map.set(row.template_id, existing);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Cloning helpers
// ---------------------------------------------------------------------------

/**
 * Clone an existing template with a new name.
 * Creates a fresh template copying the source's script and description.
 * Tags can be inherited or overridden. Version history is NOT copied —
 * the clone starts at version 1 with a single version snapshot.
 */
export function cloneTemplate(
  sourceId: string,
  newName: string,
  newDescription?: string,
  newTags?: string[],
): WorkflowTemplate | undefined {
  const source = getTemplate(sourceId);
  if (!source) return undefined;

  return createTemplate({
    name: newName,
    description: newDescription ?? source.description,
    script: source.script,
    tags: newTags ?? source.tags,
  });
}
