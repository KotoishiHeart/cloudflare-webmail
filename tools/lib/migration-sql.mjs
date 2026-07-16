export function renderMigratedMessageSql(message, createdAt) {
  const messageCreatedAt = message.createdAt ?? createdAt;
  const statements = [sql(`
    INSERT INTO messages (
      id, mailbox_id, direction, status, processing_error,
      envelope_from, delivered_to, rfc_message_id, in_reply_to, references_header,
      subject, sender, recipients, cc, reply_to, date_header, received_at,
      text_preview, raw_key, raw_sha256, raw_etag, raw_size,
      body_text_key, body_html_key, attachment_count,
      is_read, is_starred, is_archived, is_deleted, created_at, updated_at
    ) VALUES (
      ${values([
        message.id, message.mailboxId, message.direction, message.status,
        message.processingError, message.envelopeFrom, message.deliveredTo,
        message.rfcMessageId, message.inReplyTo, message.referencesHeader,
        message.subject, message.sender, message.recipients, message.cc,
        message.replyTo, message.dateHeader, message.receivedAt,
        message.textPreview, message.rawKey, message.rawSha256, message.rawEtag,
        message.rawSize, message.bodyTextKey, message.bodyHtmlKey,
        message.attachments.length, flag(message.flags.isRead),
        flag(message.flags.isStarred), flag(message.flags.isArchived),
        flag(message.flags.isDeleted), messageCreatedAt, messageCreatedAt,
      ])}
    ) ON CONFLICT DO NOTHING
  `)];
  for (const attachment of message.attachments) {
    statements.push(sql(`
      INSERT INTO attachments (
        message_id, ordinal, filename, content_type, disposition,
        content_id, size, sha256, storage_key, created_at
      )
      SELECT ${values([
        message.id, attachment.ordinal, attachment.filename, attachment.contentType,
        attachment.disposition, attachment.contentId, attachment.size,
        attachment.sha256, attachment.key, messageCreatedAt,
      ])}
      WHERE EXISTS (
        SELECT 1 FROM messages WHERE id = ${q(message.id)} AND raw_sha256 = ${q(message.rawSha256)}
      )
      ON CONFLICT DO NOTHING
    `));
  }
  return statements.join('\n\n');
}

function values(items) {
  return items.map((value) => value === null ? 'NULL' : typeof value === 'number' ? String(value) : q(value)).join(', ');
}

function flag(value) {
  return value ? 1 : 0;
}

function q(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sql(value) {
  return `${value.trim().replace(/^ {4}/gmu, '')};`;
}
