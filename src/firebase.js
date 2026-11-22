import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// Firebase web configuration identifies the project; access is controlled by Authentication and Firestore rules.
const firebaseConfig = {
  apiKey: 'AIzaSyDpr03A1_ox1NeoBS_7G6kB972NillsXkw',
  authDomain: 'wewatch-v2.firebaseapp.com',
  projectId: 'wewatch-v2',
  storageBucket: 'wewatch-v2.firebasestorage.app',
  messagingSenderId: '171906738946',
  appId: '1:171906738946:web:73ef71b82083f056cbb01b',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
