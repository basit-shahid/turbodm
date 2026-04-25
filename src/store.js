const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Store {
  constructor(fileName = 'tdm-config.json') {
    this.path = path.join(app.getPath('userData'), fileName);
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.path)) {
        const raw = fs.readFileSync(this.path, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error('Store load error:', e.message);
    }
    return {};
  }

  _save() {
    try {
      const dir = path.dirname(this.path);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (e) {
      console.error('Store save error:', e.message);
    }
  }

  get(key, defaultValue = undefined) {
    return this.data[key] !== undefined ? this.data[key] : defaultValue;
  }

  set(key, value) {
    this.data[key] = value;
    this._save();
  }

  delete(key) {
    delete this.data[key];
    this._save();
  }

  clear() {
    this.data = {};
    this._save();
  }
}

module.exports = Store;
