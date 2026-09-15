import { config } from '../config.ts';
import { migrate, openDatabase } from './connection.ts';

const db = openDatabase(config.dbPath);
const ran = migrate(db);
console.log(ran.length ? `Körde migrationer: ${ran.join(', ')}` : 'Databasen är redan uppdaterad.');
db.close();
