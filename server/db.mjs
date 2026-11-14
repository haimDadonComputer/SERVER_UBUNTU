import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
export function openDatabase(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(dir, 'control.sqlite'));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,totp TEXT,pending_totp TEXT,last_totp INTEGER DEFAULT -1);
 CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),csrf TEXT NOT NULL,created INTEGER NOT NULL,touched INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,time TEXT DEFAULT CURRENT_TIMESTAMP,user TEXT,action TEXT,target TEXT,result TEXT);
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,root TEXT UNIQUE NOT NULL,service TEXT,kind TEXT NOT NULL,repo TEXT,branch TEXT,health_port INTEGER,last_sync TEXT);
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,resource TEXT,status TEXT,stage TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP,finished TEXT,error TEXT);
 CREATE TABLE IF NOT EXISTS attempts(ip TEXT PRIMARY KEY,count INTEGER,until INTEGER);
 `);
    const columns = new Set(
        db
            .prepare('PRAGMA table_info(projects)')
            .all()
            .map((c) => c.name)
    );
    if (!columns.has('auth'))
        db.exec("ALTER TABLE projects ADD COLUMN auth TEXT NOT NULL DEFAULT 'deploy-key'");
    if (!columns.has('github_repository_id'))
        db.exec('ALTER TABLE projects ADD COLUMN github_repository_id INTEGER');
    if (!columns.has('lifecycle_json'))
        db.exec("ALTER TABLE projects ADD COLUMN lifecycle_json TEXT NOT NULL DEFAULT '{}'");
    if (!columns.has('update_state'))
        db.exec("ALTER TABLE projects ADD COLUMN update_state TEXT NOT NULL DEFAULT '{}'");
    const jobColumns = new Set(
        db
            .prepare('PRAGMA table_info(jobs)')
            .all()
            .map((c) => c.name)
    );
    if (!jobColumns.has('error_details')) db.exec('ALTER TABLE jobs ADD COLUMN error_details TEXT');
    db.exec(
        "UPDATE jobs SET status='interrupted',error='Application restarted; inspect project state before retrying' WHERE status IN ('queued','running')"
    );
    return db;
}
export function audit(db, user, action, target, result = 'ok') {
    db.prepare('INSERT INTO audit(user,action,target,result) VALUES(?,?,?,?)').run(
        user || 'system',
        action,
        String(target).slice(0, 200),
        result
    );
}
