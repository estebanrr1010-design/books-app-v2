import Dexie, { type Table } from 'dexie';

export interface SavedBook {
  id?: number;
  title: string;
  author: string;
  isbn: string;
  coverUrl: string;
  spineUrl?: string;
  backCoverUrl?: string;
  color: string;
  rating: number;
  review: string;
  pageCount?: number;
  customHeight?: number;
  customThickness?: number;
  customDepth?: number;
  format?: string;
  shelfRow?: number;
  shelfIndex?: number;
  dateAdded: number;
}

export class BooksDatabase extends Dexie {
  books!: Table<SavedBook>;

  constructor() {
    super('BooksAppDB');
    this.version(5).stores({
      books: '++id, isbn, title, shelfRow, shelfIndex, dateAdded'
    });
  }
}

export const db = new BooksDatabase();