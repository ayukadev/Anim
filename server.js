'use strict';
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// Le front et l'API sont sur la même origine : pas de CORS ouvert (sinon n'importe quel site
// pourrait ouvrir une socket avec les cookies du joueur).
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const ANIMATOR_ID = String(process.env.ANIMATOR_ID || '1425928135832109198').trim();
const DISCORD_INVITE_URL = process.env.DISCORD_INVITE_URL || process.env.INVITE_DISCORD_URL || 'https://discord.gg/TON-INVITE';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('⚠️  DISCORD_CLIENT_ID / SECRET manquant dans .env');
}

// --- SESSION SIGNÉE ---
// L'identité d'un joueur (et donc le statut d'animateur) ne vient JAMAIS du navigateur :
// elle est lue dans un cookie httpOnly signé posé par le serveur après l'OAuth2 Discord.
// SESSION_SECRET est optionnel (par défaut dérivé du secret Discord, donc stable entre redémarrages).
const SESSION_SECRET = process.env.SESSION_SECRET
  || (CLIENT_SECRET
    ? crypto.createHash('sha256').update('ap-session:' + CLIENT_SECRET).digest('hex')
    : crypto.randomBytes(32).toString('hex'));
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function signSession(user) {
  const payload = Buffer.from(JSON.stringify({
    id: String(user.id),
    username: String(user.username || 'joueur'),
    avatar: user.avatar || null,
    exp: Date.now() + SESSION_MAX_AGE_MS
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url'));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!d || !d.id || typeof d.exp !== 'number' || d.exp < Date.now()) return null;
    return { id: String(d.id), username: String(d.username || 'joueur'), avatar: d.avatar || null };
  } catch {
    return null;
  }
}

function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    let val = part.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
  });
  return out;
}

const isAnimatorUser = (user) => !!user && String(user.id).trim() === ANIMATOR_ID;

app.set('trust proxy', 1); // derrière un proxy (Render, Railway, nginx...) : req.secure fonctionne
app.use(cookieParser());
app.use(express.json({ limit: '10kb' }));

// IMPORTANT : on ne sert plus tout le dossier du projet (express.static(__dirname) exposait
// server.js avec toutes les réponses, package.json, etc.). Seul le front est public.
app.get(['/', '/index.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- QUESTIONS BANK ---
const QUESTIONS_BANK = [
  {
    "type": "PRIX",
    "q": "Un café allongé en terrasse à Paris ?",
    "unit": "En €",
    "answer": 3
  },
  {
    "type": "PRIX",
    "q": "Un menu Best Of Big Mac + frites + boisson sur place ?",
    "unit": "En €",
    "answer": 9
  },
  {
    "type": "PRIX",
    "q": "Une baguette tradition chez un artisan boulanger ?",
    "unit": "En €",
    "answer": 2
  },
  {
    "type": "PRIX",
    "q": "Une pinte de blonde 50cl en bar à Paris ?",
    "unit": "En €",
    "answer": 8
  },
  {
    "type": "PRIX",
    "q": "Un ticket de métro T+ à Paris ?",
    "unit": "En €",
    "answer": 2
  },
  {
    "type": "PRIX",
    "q": "Une place de cinéma plein tarif Pathé ?",
    "unit": "En €",
    "answer": 15
  },
  {
    "type": "PRIX",
    "q": "Un abonnement Netflix Premium par mois ?",
    "unit": "En €",
    "answer": 20
  },
  {
    "type": "PRIX",
    "q": "Un abonnement Spotify Duo par mois ?",
    "unit": "En €",
    "answer": 15
  },
  {
    "type": "PRIX",
    "q": "Un iPhone 15 128Go neuf ?",
    "unit": "En €",
    "answer": 970
  },
  {
    "type": "PRIX",
    "q": "Un MacBook Air M2 256Go neuf ?",
    "unit": "En €",
    "answer": 1299
  },
  {
    "type": "PRIX",
    "q": "Une PS5 Standard neuve ?",
    "unit": "En €",
    "answer": 500
  },
  {
    "type": "PRIX",
    "q": "Une Nintendo Switch OLED neuve ?",
    "unit": "En €",
    "answer": 330
  },
  {
    "type": "PRIX",
    "q": "Une paire de Nike Air Force 1 Low ?",
    "unit": "En €",
    "answer": 120
  },
  {
    "type": "PRIX",
    "q": "Un plein de 50L de SP95 ?",
    "unit": "En €",
    "answer": 95
  },
  {
    "type": "PRIX",
    "q": "Un paquet de Marlboro Rouge ?",
    "unit": "En €",
    "answer": 12
  },
  {
    "type": "PRIX",
    "q": "Une coupe homme chez un barber à Paris ?",
    "unit": "En €",
    "answer": 25
  },
  {
    "type": "PRIX",
    "q": "Un abonnement Basic-Fit Confort par mois ?",
    "unit": "En €",
    "answer": 26
  },
  {
    "type": "PRIX",
    "q": "Une course Uber X de 5km à Paris ?",
    "unit": "En €",
    "answer": 16
  },
  {
    "type": "PRIX",
    "q": "Un menu Big Mac + McFlurry livré Uber Eats avec frais ?",
    "unit": "En €",
    "answer": 18
  },
  {
    "type": "PRIX",
    "q": "Des AirPods Pro 2e génération ?",
    "unit": "En €",
    "answer": 279
  },
  {
    "type": "PRIX",
    "q": "Un caddie moyen Lidl pour 2 personnes pour 1 semaine ?",
    "unit": "En €",
    "answer": 85
  },
  {
    "type": "PRIX",
    "q": "Un kebab complet avec frites ?",
    "unit": "En €",
    "answer": 8
  },
  {
    "type": "PRIX",
    "q": "Un tacos 3 viandes + frites ?",
    "unit": "En €",
    "answer": 10
  },
  {
    "type": "PRIX",
    "q": "Une pizza Margherita 30cm à emporter ?",
    "unit": "En €",
    "answer": 9
  },
  {
    "type": "PRIX",
    "q": "Un croissant pur beurre en boulangerie ?",
    "unit": "En €",
    "answer": 1
  },
  {
    "type": "PRIX",
    "q": "Un pain au chocolat en boulangerie ?",
    "unit": "En €",
    "answer": 1
  },
  {
    "type": "PRIX",
    "q": "Un iPhone 15 Pro Max 256Go ?",
    "unit": "En €",
    "answer": 1470
  },
  {
    "type": "PRIX",
    "q": "Un MacBook Pro 14 pouces M3 ?",
    "unit": "En €",
    "answer": 2200
  },
  {
    "type": "PRIX",
    "q": "Une trottinette Xiaomi Electric Scooter 4 ?",
    "unit": "En €",
    "answer": 499
  },
  {
    "type": "PRIX",
    "q": "Un vélo électrique Decathlon 500E ?",
    "unit": "En €",
    "answer": 999
  },
  {
    "type": "PRIX",
    "q": "Un abonnement ChatGPT Plus ?",
    "unit": "En €",
    "answer": 20
  },
  {
    "type": "PRIX",
    "q": "Une entrée Louvre plein tarif ?",
    "unit": "En €",
    "answer": 22
  },
  {
    "type": "PRIX",
    "q": "Un sandwich jambon-beurre à Paris ?",
    "unit": "En €",
    "answer": 6
  },
  {
    "type": "PRIX",
    "q": "Un cocktail Spritz en terrasse ?",
    "unit": "En €",
    "answer": 11
  },
  {
    "type": "PRIX",
    "q": "Un paquet de pâtes 500g ?",
    "unit": "En €",
    "answer": 1
  },
  {
    "type": "PRIX",
    "q": "Un kilo de poulet Label Rouge ?",
    "unit": "En €",
    "answer": 12
  },
  {
    "type": "PRIX",
    "q": "Un litre de lait demi-écrémé ?",
    "unit": "En €",
    "answer": 1
  },
  {
    "type": "PRIX",
    "q": "Un abonnement Le Monde numérique ?",
    "unit": "En €",
    "answer": 18
  },
  {
    "type": "PRIX",
    "q": "Une manette PS5 DualSense ?",
    "unit": "En €",
    "answer": 70
  },
  {
    "type": "PRIX",
    "q": "Un jeu PS5 neuf ?",
    "unit": "En €",
    "answer": 70
  },
  {
    "type": "PRIX",
    "q": "Un billet TGV Paris-Lyon acheté à l'avance ?",
    "unit": "En €",
    "answer": 45
  },
  {
    "type": "PRIX",
    "q": "Un vol Paris-Nice aller simple ?",
    "unit": "En €",
    "answer": 60
  },
  {
    "type": "PRIX",
    "q": "Un sandwich triangle en gare ?",
    "unit": "En €",
    "answer": 5
  },
  {
    "type": "PRIX",
    "q": "Un Red Bull 25cl en bar ?",
    "unit": "En €",
    "answer": 6
  },
  {
    "type": "PRIX",
    "q": "Un kebab Uber Eats avec frites et boisson livré ?",
    "unit": "En €",
    "answer": 16
  },
  {
    "type": "PRIX",
    "q": "Une bouteille Evian 1,5L ?",
    "unit": "En €",
    "answer": 1
  },
  {
    "type": "PRIX",
    "q": "Un pack de 6 oeufs plein air ?",
    "unit": "En €",
    "answer": 4
  },
  {
    "type": "PRIX",
    "q": "Un kilo de tomates cerises ?",
    "unit": "En €",
    "answer": 6
  },
  {
    "type": "PRIX",
    "q": "Un abonnement Deezer Premium ?",
    "unit": "En €",
    "answer": 12
  },
  {
    "type": "PRIX",
    "q": "Un MacBook Air 15 pouces M2 ?",
    "unit": "En €",
    "answer": 1550
  },
  {
    "type": "PRIX",
    "q": "Un iPad 10e génération 64Go ?",
    "unit": "En €",
    "answer": 440
  },
  {
    "type": "PRIX",
    "q": "Un casque Sony WH-1000XM5 ?",
    "unit": "En €",
    "answer": 350
  },
  {
    "type": "PRIX",
    "q": "Un forfait Free 100Go ?",
    "unit": "En €",
    "answer": 20
  },
  {
    "type": "PRIX",
    "q": "Un litre d'huile d'olive extra vierge ?",
    "unit": "En €",
    "answer": 10
  },
  {
    "type": "PRIX",
    "q": "Un pot Nutella 750g ?",
    "unit": "En €",
    "answer": 6
  },
  {
    "type": "PRIX",
    "q": "Un Happy Meal McDo ?",
    "unit": "En €",
    "answer": 5
  },
  {
    "type": "PRIX",
    "q": "Un Whopper chez Burger King ?",
    "unit": "En €",
    "answer": 7
  },
  {
    "type": "PRIX",
    "q": "Un café Starbucks Tall filtre ?",
    "unit": "En €",
    "answer": 4
  },
  {
    "type": "PRIX",
    "q": "Un bubble tea classique ?",
    "unit": "En €",
    "answer": 6
  },
  {
    "type": "PRIX",
    "q": "Une assiette kebab avec frites ?",
    "unit": "En €",
    "answer": 12
  },
  {
    "type": "PRIX",
    "q": "Un tacos M 1 viande ?",
    "unit": "En €",
    "answer": 7
  },
  {
    "type": "PRIX",
    "q": "Un grec complet + canette en formule ?",
    "unit": "En €",
    "answer": 9
  },
  {
    "type": "PRIX",
    "q": "Un panier de courses Carrefour de 15 articles du quotidien ?",
    "unit": "En €",
    "answer": 45
  },
  {
    "type": "PRIX",
    "q": "Un ticket RER Paris-La Défense ?",
    "unit": "En €",
    "answer": 3
  },
  {
    "type": "PRIX",
    "q": "Un pass Navigo toutes zones mensuel ?",
    "unit": "En €",
    "answer": 86
  },
  {
    "type": "PRIX",
    "q": "Un abonnement Vélib' annuel ?",
    "unit": "En €",
    "answer": 37
  },
  {
    "type": "PRIX",
    "q": "Un cours de sport à l'unité Basic-Fit ?",
    "unit": "En €",
    "answer": 18
  },
  {
    "type": "PRIX",
    "q": "Un paquet de chips Lay's 300g ?",
    "unit": "En €",
    "answer": 3
  },
  {
    "type": "PRIX",
    "q": "Un Kinder Bueno x2 ?",
    "unit": "En €",
    "answer": 1
  },
  {
    "type": "PRIX",
    "q": "Un McFlurry Oreo ?",
    "unit": "En €",
    "answer": 4
  },
  {
    "type": "PRIX",
    "q": "Une glace 2 boules Amorino ?",
    "unit": "En €",
    "answer": 7
  },
  {
    "type": "PRIX",
    "q": "Un kebab vegan complet ?",
    "unit": "En €",
    "answer": 9
  },
  {
    "type": "PRIX",
    "q": "Un burger artisan en restaurant ?",
    "unit": "En €",
    "answer": 17
  },
  {
    "type": "PRIX",
    "q": "Un brunch à Paris le dimanche ?",
    "unit": "En €",
    "answer": 26
  },
  {
    "type": "PRIX",
    "q": "Une Corona 33cl en supermarché ?",
    "unit": "En €",
    "answer": 1
  },
  {
    "type": "PRIX",
    "q": "Un pack 6 Heineken 25cl ?",
    "unit": "En €",
    "answer": 6
  },
  {
    "type": "PRIX",
    "q": "Une bouteille rosé Côtes de Provence 75cl ?",
    "unit": "En €",
    "answer": 10
  },
  {
    "type": "PRIX",
    "q": "Un livre poche Folio neuf ?",
    "unit": "En €",
    "answer": 9
  },
  {
    "type": "PRIX",
    "q": "Un vinyle neuf standard ?",
    "unit": "En €",
    "answer": 28
  },
  {
    "type": "PRIX",
    "q": "Un t-shirt Uniqlo U blanc ?",
    "unit": "En €",
    "answer": 15
  },
  {
    "type": "PRIX",
    "q": "Un jean Levi's 501 neuf ?",
    "unit": "En €",
    "answer": 120
  },
  {
    "type": "PRIX",
    "q": "Une paire de Converse Chuck Taylor ?",
    "unit": "En €",
    "answer": 80
  },
  {
    "type": "PRIX",
    "q": "Un chargeur Apple USB-C 20W ?",
    "unit": "En €",
    "answer": 25
  },
  {
    "type": "PRIX",
    "q": "Une Apple Watch SE 2023 ?",
    "unit": "En €",
    "answer": 279
  },
  {
    "type": "PRIX",
    "q": "Un jeu Switch neuf ?",
    "unit": "En €",
    "answer": 55
  },
  {
    "type": "PRIX",
    "q": "Un abonnement Nintendo Online Famille par an ?",
    "unit": "En €",
    "answer": 35
  },
  {
    "type": "PRIX",
    "q": "Un ticket de bus à Lyon ?",
    "unit": "En €",
    "answer": 2
  },
  {
    "type": "PRIX",
    "q": "Un croque-monsieur en brasserie ?",
    "unit": "En €",
    "answer": 10
  },
  {
    "type": "PRIX",
    "q": "Un steak-frites en brasserie parisienne ?",
    "unit": "En €",
    "answer": 21
  },
  {
    "type": "PRIX",
    "q": "Un café + croissant formule matinale ?",
    "unit": "En €",
    "answer": 5
  },
  {
    "type": "PRIX",
    "q": "Un paquet Haribo Dragibus 300g ?",
    "unit": "En €",
    "answer": 2
  },
  {
    "type": "PRIX",
    "q": "Un menu tacos XL + boisson ?",
    "unit": "En €",
    "answer": 12
  },
  {
    "type": "PRIX",
    "q": "Un sandwich triangle poulet en boulangerie ?",
    "unit": "En €",
    "answer": 5
  },
  {
    "type": "PRIX",
    "q": "Une bouteille de champagne entrée de gamme ?",
    "unit": "En €",
    "answer": 25
  },
  {
    "type": "PRIX",
    "q": "Un pot de glace Häagen-Dazs 500ml ?",
    "unit": "En €",
    "answer": 7
  },
  {
    "type": "PRIX",
    "q": "Une entrée au zoo de Beauval adulte ?",
    "unit": "En €",
    "answer": 37
  },
  {
    "type": "PRIX",
    "q": "Un ticket Parc Astérix adulte ?",
    "unit": "En €",
    "answer": 60
  },
  {
    "type": "PRIX",
    "q": "Un abonnement Canal+ Sport ?",
    "unit": "En €",
    "answer": 35
  },
  {
    "type": "PRIX",
    "q": "Un plein de granulés bois 15kg ?",
    "unit": "En €",
    "answer": 8
  },
  {
    "type": "PRIX",
    "q": "Un litre d'essence SP98 ?",
    "unit": "En €",
    "answer": 2
  },
  {
    "type": "POIDS",
    "q": "Poids d'un éléphant d'Afrique mâle adulte ?",
    "unit": "En kg",
    "answer": 6000
  },
  {
    "type": "POIDS",
    "q": "Poids d'une baleine bleue adulte ?",
    "unit": "En kg",
    "answer": 130000
  },
  {
    "type": "POIDS",
    "q": "Poids d'un ours polaire mâle ?",
    "unit": "En kg",
    "answer": 500
  },
  {
    "type": "POIDS",
    "q": "Poids d'un hippopotame adulte ?",
    "unit": "En kg",
    "answer": 1500
  },
  {
    "type": "POIDS",
    "q": "Poids d'une girafe adulte ?",
    "unit": "En kg",
    "answer": 1200
  },
  {
    "type": "POIDS",
    "q": "Poids d'un lion mâle adulte ?",
    "unit": "En kg",
    "answer": 190
  },
  {
    "type": "POIDS",
    "q": "Poids d'une Renault Clio 5 à vide ?",
    "unit": "En kg",
    "answer": 1180
  },
  {
    "type": "POIDS",
    "q": "Poids d'une Tesla Model 3 ?",
    "unit": "En kg",
    "answer": 1830
  },
  {
    "type": "POIDS",
    "q": "Poids d'un frigo américain vide ?",
    "unit": "En kg",
    "answer": 110
  },
  {
    "type": "POIDS",
    "q": "Poids d'un piano à queue de concert ?",
    "unit": "En kg",
    "answer": 500
  },
  {
    "type": "POIDS",
    "q": "Poids moyen d'un homme adulte en France ?",
    "unit": "En kg",
    "answer": 81
  },
  {
    "type": "POIDS",
    "q": "Poids d'un bébé à la naissance ?",
    "unit": "En kg",
    "answer": 3
  },
  {
    "type": "POIDS",
    "q": "Poids d'un sac de ciment standard ?",
    "unit": "En kg",
    "answer": 25
  },
  {
    "type": "POIDS",
    "q": "Poids d'un vélo électrique moyen ?",
    "unit": "En kg",
    "answer": 24
  },
  {
    "type": "POIDS",
    "q": "Poids d'un canapé 3 places ?",
    "unit": "En kg",
    "answer": 85
  },
  {
    "type": "POIDS",
    "q": "Poids d'un anaconda vert adulte ?",
    "unit": "En kg",
    "answer": 100
  },
  {
    "type": "POIDS",
    "q": "Poids d'un grand requin blanc ?",
    "unit": "En kg",
    "answer": 1100
  },
  {
    "type": "POIDS",
    "q": "Poids d'un gorille dos argenté ?",
    "unit": "En kg",
    "answer": 180
  },
  {
    "type": "POIDS",
    "q": "Poids d'une vache laitière ?",
    "unit": "En kg",
    "answer": 700
  },
  {
    "type": "POIDS",
    "q": "Poids d'un cheval de course ?",
    "unit": "En kg",
    "answer": 500
  },
  {
    "type": "POIDS",
    "q": "Poids d'une moto Harley Street Glide ?",
    "unit": "En kg",
    "answer": 370
  },
  {
    "type": "POIDS",
    "q": "Poids d'un lave-linge 8kg ?",
    "unit": "En kg",
    "answer": 70
  },
  {
    "type": "POIDS",
    "q": "Poids d'un micro-ondes ?",
    "unit": "En kg",
    "answer": 14
  },
  {
    "type": "POIDS",
    "q": "Poids d'un ballon de foot ?",
    "unit": "En g",
    "answer": 430
  },
  {
    "type": "POIDS",
    "q": "Poids d'une table de ping-pong ?",
    "unit": "En kg",
    "answer": 80
  },
  {
    "type": "POIDS",
    "q": "Poids d'une bouteille d'eau 1,5L pleine ?",
    "unit": "En kg",
    "answer": 2
  },
  {
    "type": "POIDS",
    "q": "Poids d'un MacBook Pro 14 pouces ?",
    "unit": "En kg",
    "answer": 2
  },
  {
    "type": "POIDS",
    "q": "Poids d'une valise cabine vide ?",
    "unit": "En kg",
    "answer": 3
  },
  {
    "type": "POIDS",
    "q": "Poids d'un sac à dos rempli pour les cours ?",
    "unit": "En kg",
    "answer": 6
  },
  {
    "type": "POIDS",
    "q": "Poids d'un grizzli mâle ?",
    "unit": "En kg",
    "answer": 350
  },
  {
    "type": "POIDS",
    "q": "Poids d'un panda géant ?",
    "unit": "En kg",
    "answer": 110
  },
  {
    "type": "POIDS",
    "q": "Poids d'un kangourou roux mâle ?",
    "unit": "En kg",
    "answer": 90
  },
  {
    "type": "POIDS",
    "q": "Poids d'une autruche ?",
    "unit": "En kg",
    "answer": 130
  },
  {
    "type": "POIDS",
    "q": "Poids d'un thon rouge de 2m ?",
    "unit": "En kg",
    "answer": 250
  },
  {
    "type": "POIDS",
    "q": "Poids d'un crocodile du Nil ?",
    "unit": "En kg",
    "answer": 500
  },
  {
    "type": "POIDS",
    "q": "Poids d'un rhinocéros blanc ?",
    "unit": "En kg",
    "answer": 2300
  },
  {
    "type": "POIDS",
    "q": "Poids d'un bison d'Amérique ?",
    "unit": "En kg",
    "answer": 900
  },
  {
    "type": "POIDS",
    "q": "Poids d'un morse mâle ?",
    "unit": "En kg",
    "answer": 1200
  },
  {
    "type": "POIDS",
    "q": "Poids d'un berger allemand ?",
    "unit": "En kg",
    "answer": 35
  },
  {
    "type": "POIDS",
    "q": "Poids d'un Maine Coon mâle ?",
    "unit": "En kg",
    "answer": 8
  },
  {
    "type": "POIDS",
    "q": "Poids d'un dauphin commun ?",
    "unit": "En kg",
    "answer": 200
  },
  {
    "type": "POIDS",
    "q": "Poids d'un loup gris ?",
    "unit": "En kg",
    "answer": 45
  },
  {
    "type": "POIDS",
    "q": "Poids d'un chameau ?",
    "unit": "En kg",
    "answer": 600
  },
  {
    "type": "POIDS",
    "q": "Poids d'un orang-outan mâle ?",
    "unit": "En kg",
    "answer": 85
  },
  {
    "type": "POIDS",
    "q": "Poids d'une tortue géante des Galápagos ?",
    "unit": "En kg",
    "answer": 250
  },
  {
    "type": "POIDS",
    "q": "Poids d'un python réticulé de 6m ?",
    "unit": "En kg",
    "answer": 80
  },
  {
    "type": "POIDS",
    "q": "Poids d'un albatros hurleur ?",
    "unit": "En kg",
    "answer": 10
  },
  {
    "type": "POIDS",
    "q": "Poids d'un oeuf d'autruche ?",
    "unit": "En kg",
    "answer": 1
  },
  {
    "type": "POIDS",
    "q": "Poids d'une pastèque moyenne ?",
    "unit": "En kg",
    "answer": 5
  },
  {
    "type": "POIDS",
    "q": "Poids d'une brique creuse ?",
    "unit": "En kg",
    "answer": 3
  },
  {
    "type": "POIDS",
    "q": "Poids d'un parpaing 20cm ?",
    "unit": "En kg",
    "answer": 18
  },
  {
    "type": "POIDS",
    "q": "Poids d'un pneu de voiture 205/55 ?",
    "unit": "En kg",
    "answer": 9
  },
  {
    "type": "POIDS",
    "q": "Poids d'un vélo de route carbone ?",
    "unit": "En kg",
    "answer": 8
  },
  {
    "type": "POIDS",
    "q": "Poids d'un snowboard adulte ?",
    "unit": "En kg",
    "answer": 4
  },
  {
    "type": "POIDS",
    "q": "Poids d'un surf longboard 9 pieds ?",
    "unit": "En kg",
    "answer": 7
  },
  {
    "type": "POIDS",
    "q": "Poids d'un kayak simple ?",
    "unit": "En kg",
    "answer": 20
  },
  {
    "type": "POIDS",
    "q": "Poids d'un trampoline 3m ?",
    "unit": "En kg",
    "answer": 60
  },
  {
    "type": "POIDS",
    "q": "Poids d'une télé 55 pouces OLED ?",
    "unit": "En kg",
    "answer": 18
  },
  {
    "type": "POIDS",
    "q": "Poids d'une barre olympique à vide ?",
    "unit": "En kg",
    "answer": 20
  },
  {
    "type": "POIDS",
    "q": "Poids d'un sac de boxe 1m50 ?",
    "unit": "En kg",
    "answer": 35
  },
  {
    "type": "POIDS",
    "q": "Poids d'un ballon de basket ?",
    "unit": "En g",
    "answer": 600
  },
  {
    "type": "POIDS",
    "q": "Poids d'un casque de moto intégral ?",
    "unit": "En kg",
    "answer": 2
  },
  {
    "type": "POIDS",
    "q": "Poids d'une paire de skis alpins ?",
    "unit": "En kg",
    "answer": 5
  },
  {
    "type": "POIDS",
    "q": "Poids d'une paire de running ?",
    "unit": "En g",
    "answer": 600
  },
  {
    "type": "POIDS",
    "q": "Poids d'un pack de 6 bouteilles 1,5L ?",
    "unit": "En kg",
    "answer": 9
  },
  {
    "type": "POIDS",
    "q": "Poids d'une caisse de 24 bières 25cl ?",
    "unit": "En kg",
    "answer": 16
  },
  {
    "type": "POIDS",
    "q": "Poids d'un poulet entier cru ?",
    "unit": "En kg",
    "answer": 1
  },
  {
    "type": "POIDS",
    "q": "Poids d'une dinde de Noël 3kg ?",
    "unit": "En kg",
    "answer": 3
  },
  {
    "type": "POIDS",
    "q": "Poids d'un ananas moyen ?",
    "unit": "En kg",
    "answer": 1
  },
  {
    "type": "POIDS",
    "q": "Poids d'un sac de pommes de terre 5kg ?",
    "unit": "En kg",
    "answer": 5
  },
  {
    "type": "POIDS",
    "q": "Poids d'un pot Nutella 1kg ?",
    "unit": "En kg",
    "answer": 1
  },
  {
    "type": "POIDS",
    "q": "Poids d'une bouteille de champagne 75cl pleine ?",
    "unit": "En kg",
    "answer": 2
  },
  {
    "type": "POIDS",
    "q": "Poids d'une guitare acoustique ?",
    "unit": "En kg",
    "answer": 2
  },
  {
    "type": "POIDS",
    "q": "Poids d'une batterie 5 fûts ?",
    "unit": "En kg",
    "answer": 50
  },
  {
    "type": "POIDS",
    "q": "Poids d'une harpe de concert ?",
    "unit": "En kg",
    "answer": 36
  },
  {
    "type": "POIDS",
    "q": "Poids d'un violoncelle 4/4 ?",
    "unit": "En kg",
    "answer": 3
  },
  {
    "type": "POIDS",
    "q": "Poids d'un frigo top 120L ?",
    "unit": "En kg",
    "answer": 32
  },
  {
    "type": "POIDS",
    "q": "Poids d'un four micro-ondes combiné ?",
    "unit": "En kg",
    "answer": 20
  },
  {
    "type": "POIDS",
    "q": "Poids d'un aspirateur Dyson V15 ?",
    "unit": "En kg",
    "answer": 3
  },
  {
    "type": "POIDS",
    "q": "Poids d'une machine à café Nespresso ?",
    "unit": "En kg",
    "answer": 3
  },
  {
    "type": "POIDS",
    "q": "Poids d'un écran 27 pouces ?",
    "unit": "En kg",
    "answer": 6
  },
  {
    "type": "POIDS",
    "q": "Poids d'une chaise de bureau ergonomique ?",
    "unit": "En kg",
    "answer": 18
  },
  {
    "type": "POIDS",
    "q": "Poids d'un bureau 140cm en bois ?",
    "unit": "En kg",
    "answer": 35
  },
  {
    "type": "POIDS",
    "q": "Poids d'un matelas 140x190 mousse ?",
    "unit": "En kg",
    "answer": 18
  },
  {
    "type": "POIDS",
    "q": "Poids d'une couette 240x260 ?",
    "unit": "En kg",
    "answer": 3
  },
  {
    "type": "POIDS",
    "q": "Poids d'un dictionnaire Le Robert ?",
    "unit": "En kg",
    "answer": 2
  },
  {
    "type": "POIDS",
    "q": "Poids d'un pack de 500 feuilles A4 80g ?",
    "unit": "En kg",
    "answer": 2
  },
  {
    "type": "POIDS",
    "q": "Poids d'un sac de croquettes chien 15kg ?",
    "unit": "En kg",
    "answer": 15
  },
  {
    "type": "POIDS",
    "q": "Poids d'un pack d'eau 6x1,5L ?",
    "unit": "En kg",
    "answer": 9
  },
  {
    "type": "POIDS",
    "q": "Poids d'une bouteille de gaz butane 13kg pleine ?",
    "unit": "En kg",
    "answer": 26
  },
  {
    "type": "POIDS",
    "q": "Poids d'un vélo enfant 20 pouces ?",
    "unit": "En kg",
    "answer": 10
  },
  {
    "type": "POIDS",
    "q": "Poids d'un jerrican d'essence 20L plein ?",
    "unit": "En kg",
    "answer": 16
  },
  {
    "type": "POIDS",
    "q": "Poids d'un ordinateur tour gamer ?",
    "unit": "En kg",
    "answer": 12
  },
  {
    "type": "POIDS",
    "q": "Poids d'un tableau Ikea 100x70cm ?",
    "unit": "En kg",
    "answer": 3
  },
  {
    "type": "POIDS",
    "q": "Poids d'un barbecue Weber charbon 57cm ?",
    "unit": "En kg",
    "answer": 20
  },
  {
    "type": "POIDS",
    "q": "Poids d'un sac de charbon 10kg ?",
    "unit": "En kg",
    "answer": 10
  },
  {
    "type": "POIDS",
    "q": "Poids d'une roue de secours galette ?",
    "unit": "En kg",
    "answer": 12
  },
  {
    "type": "POIDS",
    "q": "Poids d'un moteur de voiture 4 cylindres ?",
    "unit": "En kg",
    "answer": 120
  },
  {
    "type": "POIDS",
    "q": "Poids d'un fauteuil club en cuir ?",
    "unit": "En kg",
    "answer": 35
  },
  {
    "type": "POIDS",
    "q": "Poids d'un billard américain 8ft ?",
    "unit": "En kg",
    "answer": 250
  },
  {
    "type": "DISTANCE",
    "q": "Distance autoroute Paris - Lyon ?",
    "unit": "En km",
    "answer": 460
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Marseille par autoroute ?",
    "unit": "En km",
    "answer": 775
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Bordeaux par A10 ?",
    "unit": "En km",
    "answer": 584
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Lille ?",
    "unit": "En km",
    "answer": 225
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Toulouse ?",
    "unit": "En km",
    "answer": 680
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Nice ?",
    "unit": "En km",
    "answer": 930
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Nantes ?",
    "unit": "En km",
    "answer": 385
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Strasbourg ?",
    "unit": "En km",
    "answer": 490
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Rennes ?",
    "unit": "En km",
    "answer": 350
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Brest ?",
    "unit": "En km",
    "answer": 590
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Clermont-Ferrand ?",
    "unit": "En km",
    "answer": 420
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Dijon ?",
    "unit": "En km",
    "answer": 315
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Grenoble ?",
    "unit": "En km",
    "answer": 570
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Biarritz ?",
    "unit": "En km",
    "answer": 780
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Perpignan ?",
    "unit": "En km",
    "answer": 850
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Le Havre ?",
    "unit": "En km",
    "answer": 200
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Reims ?",
    "unit": "En km",
    "answer": 145
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Calais ?",
    "unit": "En km",
    "answer": 295
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Tours ?",
    "unit": "En km",
    "answer": 240
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Orléans ?",
    "unit": "En km",
    "answer": 130
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Metz ?",
    "unit": "En km",
    "answer": 330
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Angers ?",
    "unit": "En km",
    "answer": 300
  },
  {
    "type": "DISTANCE",
    "q": "Distance Lyon - Marseille ?",
    "unit": "En km",
    "answer": 315
  },
  {
    "type": "DISTANCE",
    "q": "Distance Lyon - Toulouse ?",
    "unit": "En km",
    "answer": 540
  },
  {
    "type": "DISTANCE",
    "q": "Distance Lyon - Nice ?",
    "unit": "En km",
    "answer": 450
  },
  {
    "type": "DISTANCE",
    "q": "Distance Lyon - Bordeaux ?",
    "unit": "En km",
    "answer": 550
  },
  {
    "type": "DISTANCE",
    "q": "Distance Bordeaux - Toulouse ?",
    "unit": "En km",
    "answer": 245
  },
  {
    "type": "DISTANCE",
    "q": "Distance Marseille - Nice ?",
    "unit": "En km",
    "answer": 200
  },
  {
    "type": "DISTANCE",
    "q": "Distance Marseille - Montpellier ?",
    "unit": "En km",
    "answer": 180
  },
  {
    "type": "DISTANCE",
    "q": "Distance Lille - Bruxelles ?",
    "unit": "En km",
    "answer": 120
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Bruxelles ?",
    "unit": "En km",
    "answer": 320
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Londres ?",
    "unit": "En km",
    "answer": 470
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Barcelone ?",
    "unit": "En km",
    "answer": 1050
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Milan ?",
    "unit": "En km",
    "answer": 850
  },
  {
    "type": "DISTANCE",
    "q": "Distance totale Tour de France 2024 ?",
    "unit": "En km",
    "answer": 3498
  },
  {
    "type": "DISTANCE",
    "q": "Distance d'un marathon ?",
    "unit": "En km",
    "answer": 42
  },
  {
    "type": "DISTANCE",
    "q": "Largeur de la Manche au plus étroit ?",
    "unit": "En km",
    "answer": 34
  },
  {
    "type": "DISTANCE",
    "q": "Longueur du périphérique parisien ?",
    "unit": "En km",
    "answer": 35
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Versailles ?",
    "unit": "En km",
    "answer": 22
  },
  {
    "type": "DISTANCE",
    "q": "Distance Lyon - Grenoble ?",
    "unit": "En km",
    "answer": 110
  },
  {
    "type": "DISTANCE",
    "q": "Distance Nantes - Rennes ?",
    "unit": "En km",
    "answer": 115
  },
  {
    "type": "DISTANCE",
    "q": "Distance Toulouse - Montpellier ?",
    "unit": "En km",
    "answer": 245
  },
  {
    "type": "DISTANCE",
    "q": "Distance Bordeaux - Biarritz ?",
    "unit": "En km",
    "answer": 200
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - New York à vol d'oiseau ?",
    "unit": "En km",
    "answer": 5840
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Tokyo à vol d'oiseau ?",
    "unit": "En km",
    "answer": 9720
  },
  {
    "type": "DISTANCE",
    "q": "Longueur de la Seine ?",
    "unit": "En km",
    "answer": 777
  },
  {
    "type": "DISTANCE",
    "q": "Longueur de la Loire ?",
    "unit": "En km",
    "answer": 1012
  },
  {
    "type": "DISTANCE",
    "q": "Tour du monde à l'équateur ?",
    "unit": "En km",
    "answer": 40075
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Le Mans ?",
    "unit": "En km",
    "answer": 210
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Deauville ?",
    "unit": "En km",
    "answer": 200
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Chamonix ?",
    "unit": "En km",
    "answer": 610
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Annecy ?",
    "unit": "En km",
    "answer": 540
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - La Rochelle ?",
    "unit": "En km",
    "answer": 480
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Saint-Tropez ?",
    "unit": "En km",
    "answer": 890
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Avignon ?",
    "unit": "En km",
    "answer": 690
  },
  {
    "type": "DISTANCE",
    "q": "Distance entre deux stations de métro à Paris en moyenne ?",
    "unit": "En m",
    "answer": 550
  },
  {
    "type": "DISTANCE",
    "q": "Longueur du Pont de Normandie ?",
    "unit": "En km",
    "answer": 2
  },
  {
    "type": "DISTANCE",
    "q": "Longueur du viaduc de Millau ?",
    "unit": "En km",
    "answer": 2
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Berlin ?",
    "unit": "En km",
    "answer": 1050
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Rome ?",
    "unit": "En km",
    "answer": 1110
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Madrid ?",
    "unit": "En km",
    "answer": 1270
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Amsterdam ?",
    "unit": "En km",
    "answer": 510
  },
  {
    "type": "DISTANCE",
    "q": "Distance Lyon - Paris en TGV (rail) ?",
    "unit": "En km",
    "answer": 430
  },
  {
    "type": "DISTANCE",
    "q": "Distance Terre - Lune ?",
    "unit": "En km",
    "answer": 384400
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Mont Saint-Michel ?",
    "unit": "En km",
    "answer": 360
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Étretat ?",
    "unit": "En km",
    "answer": 205
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Honfleur ?",
    "unit": "En km",
    "answer": 190
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Cabourg ?",
    "unit": "En km",
    "answer": 220
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Le Touquet ?",
    "unit": "En km",
    "answer": 240
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Saint-Malo ?",
    "unit": "En km",
    "answer": 410
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Quimper ?",
    "unit": "En km",
    "answer": 590
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Figari (Corse) à vol d'oiseau ?",
    "unit": "En km",
    "answer": 930
  },
  {
    "type": "DISTANCE",
    "q": "Longueur du Canal du Midi ?",
    "unit": "En km",
    "answer": 240
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Genève ?",
    "unit": "En km",
    "answer": 540
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Luxembourg ?",
    "unit": "En km",
    "answer": 380
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Andorre ?",
    "unit": "En km",
    "answer": 715
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - San Sebastian ?",
    "unit": "En km",
    "answer": 815
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Dakar à vol d'oiseau ?",
    "unit": "En km",
    "answer": 4250
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Montréal ?",
    "unit": "En km",
    "answer": 5510
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Los Angeles ?",
    "unit": "En km",
    "answer": 9100
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Sydney ?",
    "unit": "En km",
    "answer": 16950
  },
  {
    "type": "DISTANCE",
    "q": "Distance d'un semi-marathon ?",
    "unit": "En km",
    "answer": 21
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Marrakech ?",
    "unit": "En km",
    "answer": 2150
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Athènes ?",
    "unit": "En km",
    "answer": 2100
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Istanbul ?",
    "unit": "En km",
    "answer": 2250
  },
  {
    "type": "DISTANCE",
    "q": "Longueur de la Grande Muraille de Chine ?",
    "unit": "En km",
    "answer": 21196
  },
  {
    "type": "DISTANCE",
    "q": "Distance Terre - Soleil en millions de km ?",
    "unit": "En millions de km",
    "answer": 150
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Nantes en train ?",
    "unit": "En km",
    "answer": 385
  },
  {
    "type": "DISTANCE",
    "q": "Distance Lyon - Turin ?",
    "unit": "En km",
    "answer": 320
  },
  {
    "type": "DISTANCE",
    "q": "Distance Toulouse - Barcelone ?",
    "unit": "En km",
    "answer": 390
  },
  {
    "type": "DISTANCE",
    "q": "Longueur des Champs-Élysées ?",
    "unit": "En km",
    "answer": 2
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Rouen ?",
    "unit": "En km",
    "answer": 135
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Caen ?",
    "unit": "En km",
    "answer": 240
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Amiens ?",
    "unit": "En km",
    "answer": 135
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Saint-Étienne ?",
    "unit": "En km",
    "answer": 470
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Le Mans à vol d'oiseau ?",
    "unit": "En km",
    "answer": 200
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Bruxelles en train ?",
    "unit": "En km",
    "answer": 320
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Londres en Eurostar ?",
    "unit": "En km",
    "answer": 470
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Bordeaux en train ?",
    "unit": "En km",
    "answer": 590
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Marseille en TGV ?",
    "unit": "En km",
    "answer": 750
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur de la Tour Eiffel avec antenne ?",
    "unit": "En m",
    "answer": 330
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un terrain de foot FIFA ?",
    "unit": "En m",
    "answer": 105
  },
  {
    "type": "LONGUEUR",
    "q": "Largeur d'un terrain de foot FIFA ?",
    "unit": "En m",
    "answer": 68
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un but de foot ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une piscine olympique ?",
    "unit": "En m",
    "answer": 50
  },
  {
    "type": "LONGUEUR",
    "q": "Taille moyenne d'un homme en France ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Taille moyenne d'une femme en France ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un bus articulé ?",
    "unit": "En m",
    "answer": 18
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur de la Statue de la Liberté avec socle ?",
    "unit": "En m",
    "answer": 93
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une baleine bleue adulte ?",
    "unit": "En m",
    "answer": 25
  },
  {
    "type": "LONGUEUR",
    "q": "Taille d'un nouveau-né moyen ?",
    "unit": "En cm",
    "answer": 50
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un lit king size ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'une porte standard ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une baguette tradition ?",
    "unit": "En cm",
    "answer": 65
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur du Mont Blanc ?",
    "unit": "En m",
    "answer": 4808
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une planche de surf longboard ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un panier de basket NBA ?",
    "unit": "En m",
    "answer": 3
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un terrain de basket ?",
    "unit": "En m",
    "answer": 28
  },
  {
    "type": "LONGUEUR",
    "q": "Envergure d'un albatros hurleur ?",
    "unit": "En m",
    "answer": 3
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur du Titanic ?",
    "unit": "En m",
    "answer": 269
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur de la pyramide de Khéops ?",
    "unit": "En m",
    "answer": 138
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un terrain de rugby ?",
    "unit": "En m",
    "answer": 100
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un immeuble de 10 étages ?",
    "unit": "En m",
    "answer": 30
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un Airbus A380 ?",
    "unit": "En m",
    "answer": 72
  },
  {
    "type": "LONGUEUR",
    "q": "Envergure d'un A380 ?",
    "unit": "En m",
    "answer": 79
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur de l'Arc de Triomphe ?",
    "unit": "En m",
    "answer": 50
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un vélo adulte ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un frigo américain ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une voiture Clio ?",
    "unit": "En m",
    "answer": 4
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur sous plafond standard ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un skateboard classique ?",
    "unit": "En cm",
    "answer": 80
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un snowboard adulte ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un étage d'immeuble ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un terrain de tennis ?",
    "unit": "En m",
    "answer": 23
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un filet de tennis au centre ?",
    "unit": "En cm",
    "answer": 91
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une raquette de tennis ?",
    "unit": "En cm",
    "answer": 68
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une feuille A4 ?",
    "unit": "En cm",
    "answer": 30
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur de Notre-Dame de Paris ?",
    "unit": "En m",
    "answer": 69
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur de la Seine à Paris intra-muros ?",
    "unit": "En km",
    "answer": 13
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur du Sacré-Cœur ?",
    "unit": "En m",
    "answer": 83
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un paquebot Costa Smeralda ?",
    "unit": "En m",
    "answer": 337
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur du viaduc de Millau (pilier le plus haut) ?",
    "unit": "En m",
    "answer": 343
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur du viaduc de Millau ?",
    "unit": "En m",
    "answer": 2460
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur de la Grande Arche de la Défense ?",
    "unit": "En m",
    "answer": 110
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un TGV Duplex (10 caisses) ?",
    "unit": "En m",
    "answer": 200
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un bus à impériale londonien ?",
    "unit": "En m",
    "answer": 4
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un terrain de pétanque ?",
    "unit": "En m",
    "answer": 15
  },
  {
    "type": "LONGUEUR",
    "q": "Diamètre d'un ballon de foot ?",
    "unit": "En cm",
    "answer": 22
  },
  {
    "type": "LONGUEUR",
    "q": "Taille d'une fourmi ouvrière ?",
    "unit": "En mm",
    "answer": 5
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un ver de terre moyen ?",
    "unit": "En cm",
    "answer": 15
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un python réticulé record ?",
    "unit": "En m",
    "answer": 7
  },
  {
    "type": "LONGUEUR",
    "q": "Envergure d'un condor des Andes ?",
    "unit": "En m",
    "answer": 3
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un chêne adulte ?",
    "unit": "En m",
    "answer": 25
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un golf 18 trous ?",
    "unit": "En m",
    "answer": 6000
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un sapin de Noël standard ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un canapé 3 places ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'une table à manger ?",
    "unit": "En cm",
    "answer": 75
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une baignoire standard ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un tabouret de bar ?",
    "unit": "En cm",
    "answer": 75
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un lit simple ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un tapis de yoga ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un frigo top ?",
    "unit": "En cm",
    "answer": 85
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une Tesla Model 3 ?",
    "unit": "En m",
    "answer": 4
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'une porte de garage ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une planche à repasser ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un cargo Ever Given ?",
    "unit": "En m",
    "answer": 399
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur de la Burj Khalifa ?",
    "unit": "En m",
    "answer": 828
  },
  {
    "type": "LONGUEUR",
    "q": "Profondeur de la fosse des Mariannes ?",
    "unit": "En m",
    "answer": 10925
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur du Nil ?",
    "unit": "En km",
    "answer": 6650
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur de l'Amazone ?",
    "unit": "En km",
    "answer": 6400
  },
  {
    "type": "LONGUEUR",
    "q": "Diamètre de la Lune ?",
    "unit": "En km",
    "answer": 3474
  },
  {
    "type": "LONGUEUR",
    "q": "Circonférence de la Terre à l'équateur ?",
    "unit": "En km",
    "answer": 40075
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un terrain de handball ?",
    "unit": "En m",
    "answer": 40
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un but de handball ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un billard américain 9ft ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'une table de billard ?",
    "unit": "En cm",
    "answer": 80
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une guitare Stratocaster ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Envergure d'un aigle royal ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un crocodile du Nil adulte ?",
    "unit": "En m",
    "answer": 5
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur au garrot d'un cheval de trait ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un dauphin commun ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LONGUEUR",
    "q": "Taille d'un gorille debout ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un anaconda vert ?",
    "unit": "En m",
    "answer": 5
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'une girafe mâle ?",
    "unit": "En m",
    "answer": 5
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une remorque de camion ?",
    "unit": "En m",
    "answer": 13
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un conteneur 40 pieds ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un terrain de volley ?",
    "unit": "En m",
    "answer": 18
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un filet de volley hommes ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un terrain de badminton ?",
    "unit": "En m",
    "answer": 13
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un immeuble Haussmannien 6 étages ?",
    "unit": "En m",
    "answer": 20
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur du pont de Normandie (portée principale) ?",
    "unit": "En m",
    "answer": 856
  },
  {
    "type": "LONGUEUR",
    "q": "Largeur d'une autoroute 2x3 voies ?",
    "unit": "En m",
    "answer": 30
  },
  {
    "type": "LONGUEUR",
    "q": "Profondeur moyenne de la Seine à Paris ?",
    "unit": "En m",
    "answer": 3
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un terrain de baseball ?",
    "unit": "En m",
    "answer": 27
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un poteau de rugby ?",
    "unit": "En m",
    "answer": 16
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un bus scolaire américain ?",
    "unit": "En m",
    "answer": 12
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un feu tricolore ?",
    "unit": "En m",
    "answer": 3
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une piste d'athlétisme (tour) ?",
    "unit": "En m",
    "answer": 400
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'une haie de 110m haies ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un javelot hommes ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 20m2 à Paris ?",
    "unit": "En €/mois",
    "answer": 950
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un T2 40m2 à Paris ?",
    "unit": "En €/mois",
    "answer": 1350
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un T3 65m2 à Paris ?",
    "unit": "En €/mois",
    "answer": 2100
  },
  {
    "type": "LOYER",
    "q": "Loyer d'une chambre de bonne 9m2 à Paris ?",
    "unit": "En €/mois",
    "answer": 650
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un studio à Montmartre ?",
    "unit": "En €/mois",
    "answer": 800
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un T2 dans Le Marais ?",
    "unit": "En €/mois",
    "answer": 1650
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un studio dans le 16e ?",
    "unit": "En €/mois",
    "answer": 1050
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un T2 dans le 11e ?",
    "unit": "En €/mois",
    "answer": 1250
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un studio à Bastille ?",
    "unit": "En €/mois",
    "answer": 900
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un T2 à Belleville ?",
    "unit": "En €/mois",
    "answer": 1100
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio à Lyon ?",
    "unit": "En €/mois",
    "answer": 590
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un T2 à Lyon Presqu'île ?",
    "unit": "En €/mois",
    "answer": 850
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un T3 à Lyon Part-Dieu ?",
    "unit": "En €/mois",
    "answer": 1150
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un studio étudiant à Villeurbanne ?",
    "unit": "En €/mois",
    "answer": 520
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un T2 à Lyon Confluence ?",
    "unit": "En €/mois",
    "answer": 950
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio à Marseille ?",
    "unit": "En €/mois",
    "answer": 500
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un T2 vue Vieux-Port à Marseille ?",
    "unit": "En €/mois",
    "answer": 850
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un T3 à Marseille Prado ?",
    "unit": "En €/mois",
    "answer": 1050
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un studio à Toulouse Capitole ?",
    "unit": "En €/mois",
    "answer": 540
  },
  {
    "type": "LOYER",
    "q": "Loyer d'un T2 à Toulouse Rangueil ?",
    "unit": "En €/mois",
    "answer": 680
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Toulouse ?",
    "unit": "En €/mois",
    "answer": 578
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio étudiant 18m2 à La Rochelle ?",
    "unit": "En €/mois",
    "answer": 945
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 20m2 à Montpellier ?",
    "unit": "En €/mois",
    "answer": 1176
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Nancy ?",
    "unit": "En €/mois",
    "answer": 1080
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 20m2 à Aix-en-Provence ?",
    "unit": "En €/mois",
    "answer": 726
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Bordeaux ?",
    "unit": "En €/mois",
    "answer": 1083
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Colombes ?",
    "unit": "En €/mois",
    "answer": 735
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio étudiant 18m2 à Paris ?",
    "unit": "En €/mois",
    "answer": 579
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Ajaccio ?",
    "unit": "En €/mois",
    "answer": 1173
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 20m2 à Nice ?",
    "unit": "En €/mois",
    "answer": 1046
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio étudiant 18m2 à Aulnay ?",
    "unit": "En €/mois",
    "answer": 608
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 20m2 à Bastia ?",
    "unit": "En €/mois",
    "answer": 589
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Courbevoie ?",
    "unit": "En €/mois",
    "answer": 658
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 20m2 à Saint-Maur ?",
    "unit": "En €/mois",
    "answer": 997
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio étudiant 18m2 à Cannes ?",
    "unit": "En €/mois",
    "answer": 1376
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio étudiant 18m2 à Dijon ?",
    "unit": "En €/mois",
    "answer": 475
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à La Rochelle ?",
    "unit": "En €/mois",
    "answer": 1103
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio étudiant 18m2 à Montreuil ?",
    "unit": "En €/mois",
    "answer": 823
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Aubervilliers ?",
    "unit": "En €/mois",
    "answer": 1479
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Avignon ?",
    "unit": "En €/mois",
    "answer": 425
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Amiens ?",
    "unit": "En €/mois",
    "answer": 1289
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Versailles ?",
    "unit": "En €/mois",
    "answer": 1395
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 20m2 à Argenteuil ?",
    "unit": "En €/mois",
    "answer": 771
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 20m2 à Aulnay ?",
    "unit": "En €/mois",
    "answer": 1397
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Courbevoie ?",
    "unit": "En €/mois",
    "answer": 748
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Aix-en-Provence ?",
    "unit": "En €/mois",
    "answer": 1201
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 20m2 à Ajaccio ?",
    "unit": "En €/mois",
    "answer": 1335
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Tours ?",
    "unit": "En €/mois",
    "answer": 1088
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Lyon ?",
    "unit": "En €/mois",
    "answer": 580
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Calais ?",
    "unit": "En €/mois",
    "answer": 426
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Bastia ?",
    "unit": "En €/mois",
    "answer": 869
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Caen ?",
    "unit": "En €/mois",
    "answer": 1390
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Reims ?",
    "unit": "En €/mois",
    "answer": 1498
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio étudiant 18m2 à Besançon ?",
    "unit": "En €/mois",
    "answer": 1344
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 20m2 à Marseille ?",
    "unit": "En €/mois",
    "answer": 675
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Orléans ?",
    "unit": "En €/mois",
    "answer": 443
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Dijon ?",
    "unit": "En €/mois",
    "answer": 956
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio étudiant 18m2 à Créteil ?",
    "unit": "En €/mois",
    "answer": 1260
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Argenteuil ?",
    "unit": "En €/mois",
    "answer": 581
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio étudiant 18m2 à Nantes ?",
    "unit": "En €/mois",
    "answer": 417
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Saint-Maur ?",
    "unit": "En €/mois",
    "answer": 1173
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Nice ?",
    "unit": "En €/mois",
    "answer": 1227
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Lyon ?",
    "unit": "En €/mois",
    "answer": 937
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Antibes ?",
    "unit": "En €/mois",
    "answer": 1085
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Perpignan ?",
    "unit": "En €/mois",
    "answer": 448
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Poitiers ?",
    "unit": "En €/mois",
    "answer": 1258
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Nice ?",
    "unit": "En €/mois",
    "answer": 1162
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 20m2 à Aubervilliers ?",
    "unit": "En €/mois",
    "answer": 1462
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Lille ?",
    "unit": "En €/mois",
    "answer": 1197
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Limoges ?",
    "unit": "En €/mois",
    "answer": 1495
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Aix-en-Provence ?",
    "unit": "En €/mois",
    "answer": 644
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 20m2 à Metz ?",
    "unit": "En €/mois",
    "answer": 678
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 20m2 à Orléans ?",
    "unit": "En €/mois",
    "answer": 1115
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Montreuil ?",
    "unit": "En €/mois",
    "answer": 1458
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Argenteuil ?",
    "unit": "En €/mois",
    "answer": 681
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Nancy ?",
    "unit": "En €/mois",
    "answer": 860
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Bastia ?",
    "unit": "En €/mois",
    "answer": 1096
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T3 65m2 à Nantes ?",
    "unit": "En €/mois",
    "answer": 1436
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Grenoble ?",
    "unit": "En €/mois",
    "answer": 1059
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Nanterre ?",
    "unit": "En €/mois",
    "answer": 564
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Créteil ?",
    "unit": "En €/mois",
    "answer": 1434
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 20m2 à Le Havre ?",
    "unit": "En €/mois",
    "answer": 797
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Angers ?",
    "unit": "En €/mois",
    "answer": 872
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T1 30m2 à Nantes ?",
    "unit": "En €/mois",
    "answer": 1049
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio étudiant 18m2 à Saint-Maur ?",
    "unit": "En €/mois",
    "answer": 1408
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Nantes ?",
    "unit": "En €/mois",
    "answer": 750
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Metz ?",
    "unit": "En €/mois",
    "answer": 580
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Angers ?",
    "unit": "En €/mois",
    "answer": 600
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un T2 40m2 à Strasbourg ?",
    "unit": "En €/mois",
    "answer": 650
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 18m2 à Rennes ?",
    "unit": "En €/mois",
    "answer": 654
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 18m2 à Grenoble ?",
    "unit": "En €/mois",
    "answer": 1166
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 18m2 à Lyon ?",
    "unit": "En €/mois",
    "answer": 574
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 18m2 à Tours ?",
    "unit": "En €/mois",
    "answer": 596
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 18m2 à Reims ?",
    "unit": "En €/mois",
    "answer": 1096
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 18m2 à Nancy ?",
    "unit": "En €/mois",
    "answer": 450
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 18m2 à Angers ?",
    "unit": "En €/mois",
    "answer": 460
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 18m2 à Dijon ?",
    "unit": "En €/mois",
    "answer": 571
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 18m2 à Strasbourg ?",
    "unit": "En €/mois",
    "answer": 592
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 18m2 à Poitiers ?",
    "unit": "En €/mois",
    "answer": 420
  },
  {
    "type": "LOYER",
    "q": "Loyer moyen d'un studio 18m2 à Amiens ?",
    "unit": "En €/mois",
    "answer": 626
  },
  {
    "type": "POPULATION",
    "q": "Population de Paris intra-muros ?",
    "unit": "En habitants",
    "answer": 2148000
  },
  {
    "type": "POPULATION",
    "q": "Population de Marseille ?",
    "unit": "En habitants",
    "answer": 870000
  },
  {
    "type": "POPULATION",
    "q": "Population de Lyon ?",
    "unit": "En habitants",
    "answer": 520000
  },
  {
    "type": "POPULATION",
    "q": "Population de Toulouse ?",
    "unit": "En habitants",
    "answer": 500000
  },
  {
    "type": "POPULATION",
    "q": "Population de Nice ?",
    "unit": "En habitants",
    "answer": 340000
  },
  {
    "type": "POPULATION",
    "q": "Population de Nantes ?",
    "unit": "En habitants",
    "answer": 320000
  },
  {
    "type": "POPULATION",
    "q": "Population de Montpellier ?",
    "unit": "En habitants",
    "answer": 300000
  },
  {
    "type": "POPULATION",
    "q": "Population de Strasbourg ?",
    "unit": "En habitants",
    "answer": 290000
  },
  {
    "type": "POPULATION",
    "q": "Population de Bordeaux ?",
    "unit": "En habitants",
    "answer": 260000
  },
  {
    "type": "POPULATION",
    "q": "Population de Lille ?",
    "unit": "En habitants",
    "answer": 236000
  },
  {
    "type": "POPULATION",
    "q": "Population de Rennes ?",
    "unit": "En habitants",
    "answer": 220000
  },
  {
    "type": "POPULATION",
    "q": "Population de Reims ?",
    "unit": "En habitants",
    "answer": 180000
  },
  {
    "type": "POPULATION",
    "q": "Population de Le Havre ?",
    "unit": "En habitants",
    "answer": 166000
  },
  {
    "type": "POPULATION",
    "q": "Population de Saint-Étienne ?",
    "unit": "En habitants",
    "answer": 173000
  },
  {
    "type": "POPULATION",
    "q": "Population de Toulon ?",
    "unit": "En habitants",
    "answer": 180000
  },
  {
    "type": "POPULATION",
    "q": "Population de Grenoble ?",
    "unit": "En habitants",
    "answer": 158000
  },
  {
    "type": "POPULATION",
    "q": "Population de Dijon ?",
    "unit": "En habitants",
    "answer": 155000
  },
  {
    "type": "POPULATION",
    "q": "Population de Angers ?",
    "unit": "En habitants",
    "answer": 154000
  },
  {
    "type": "POPULATION",
    "q": "Population de Nîmes ?",
    "unit": "En habitants",
    "answer": 150000
  },
  {
    "type": "POPULATION",
    "q": "Population de Villeurbanne ?",
    "unit": "En habitants",
    "answer": 150000
  },
  {
    "type": "POPULATION",
    "q": "Population de Aix-en-Provence ?",
    "unit": "En habitants",
    "answer": 145000
  },
  {
    "type": "POPULATION",
    "q": "Population de Cannes ?",
    "unit": "En habitants",
    "answer": 74000
  },
  {
    "type": "POPULATION",
    "q": "Population de Calais ?",
    "unit": "En habitants",
    "answer": 32700
  },
  {
    "type": "POPULATION",
    "q": "Population de Antibes ?",
    "unit": "En habitants",
    "answer": 76000
  },
  {
    "type": "POPULATION",
    "q": "Population de Dunkerque ?",
    "unit": "En habitants",
    "answer": 86000
  },
  {
    "type": "POPULATION",
    "q": "Population de Bastia ?",
    "unit": "En habitants",
    "answer": 45000
  },
  {
    "type": "POPULATION",
    "q": "Population de Colombes ?",
    "unit": "En habitants",
    "answer": 86000
  },
  {
    "type": "POPULATION",
    "q": "Population de Limoges ?",
    "unit": "En habitants",
    "answer": 132000
  },
  {
    "type": "POPULATION",
    "q": "Population de Clermont-Ferrand ?",
    "unit": "En habitants",
    "answer": 147000
  },
  {
    "type": "POPULATION",
    "q": "Population de Aubervilliers ?",
    "unit": "En habitants",
    "answer": 90000
  },
  {
    "type": "POPULATION",
    "q": "Population de Tours ?",
    "unit": "En habitants",
    "answer": 137000
  },
  {
    "type": "POPULATION",
    "q": "Population de Le Mans ?",
    "unit": "En habitants",
    "answer": 143000
  },
  {
    "type": "POPULATION",
    "q": "Population de Argenteuil ?",
    "unit": "En habitants",
    "answer": 111000
  },
  {
    "type": "POPULATION",
    "q": "Population de Orléans ?",
    "unit": "En habitants",
    "answer": 117000
  },
  {
    "type": "POPULATION",
    "q": "Population de Avignon ?",
    "unit": "En habitants",
    "answer": 92000
  },
  {
    "type": "POPULATION",
    "q": "Population de Courbevoie ?",
    "unit": "En habitants",
    "answer": 83000
  },
  {
    "type": "POPULATION",
    "q": "Population de Aulnay ?",
    "unit": "En habitants",
    "answer": 86000
  },
  {
    "type": "POPULATION",
    "q": "Population de Rouen ?",
    "unit": "En habitants",
    "answer": 112000
  },
  {
    "type": "POPULATION",
    "q": "Population de Créteil ?",
    "unit": "En habitants",
    "answer": 91000
  },
  {
    "type": "POPULATION",
    "q": "Population de Vitry ?",
    "unit": "En habitants",
    "answer": 94000
  },
  {
    "type": "POPULATION",
    "q": "Population de Annecy ?",
    "unit": "En habitants",
    "answer": 132000
  },
  {
    "type": "POPULATION",
    "q": "Population de Perpignan ?",
    "unit": "En habitants",
    "answer": 121000
  },
  {
    "type": "POPULATION",
    "q": "Population de Metz ?",
    "unit": "En habitants",
    "answer": 118000
  },
  {
    "type": "POPULATION",
    "q": "Population de Caen ?",
    "unit": "En habitants",
    "answer": 105000
  },
  {
    "type": "POPULATION",
    "q": "Population de Montreuil ?",
    "unit": "En habitants",
    "answer": 110000
  },
  {
    "type": "POPULATION",
    "q": "Population de Champigny ?",
    "unit": "En habitants",
    "answer": 77000
  },
  {
    "type": "POPULATION",
    "q": "Population de Poitiers ?",
    "unit": "En habitants",
    "answer": 88000
  },
  {
    "type": "POPULATION",
    "q": "Population de Amiens ?",
    "unit": "En habitants",
    "answer": 133000
  },
  {
    "type": "POPULATION",
    "q": "Population de Besançon ?",
    "unit": "En habitants",
    "answer": 117000
  },
  {
    "type": "POPULATION",
    "q": "Population de Mulhouse ?",
    "unit": "En habitants",
    "answer": 108000
  },
  {
    "type": "POPULATION",
    "q": "Population de Nancy ?",
    "unit": "En habitants",
    "answer": 104000
  },
  {
    "type": "POPULATION",
    "q": "Population de Roubaix ?",
    "unit": "En habitants",
    "answer": 99000
  },
  {
    "type": "POPULATION",
    "q": "Population de Tourcoing ?",
    "unit": "En habitants",
    "answer": 97000
  },
  {
    "type": "POPULATION",
    "q": "Population de Nanterre ?",
    "unit": "En habitants",
    "answer": 96000
  },
  {
    "type": "POPULATION",
    "q": "Population de Saint-Denis ?",
    "unit": "En habitants",
    "answer": 112000
  },
  {
    "type": "POPULATION",
    "q": "Population de Boulogne-Billancourt ?",
    "unit": "En habitants",
    "answer": 121000
  },
  {
    "type": "POPULATION",
    "q": "Population de Pau ?",
    "unit": "En habitants",
    "answer": 77000
  },
  {
    "type": "POPULATION",
    "q": "Population de La Rochelle ?",
    "unit": "En habitants",
    "answer": 76000
  },
  {
    "type": "POPULATION",
    "q": "Population de Cherbourg-en-Cotentin ?",
    "unit": "En habitants",
    "answer": 78000
  },
  {
    "type": "POPULATION",
    "q": "Population de Chambéry ?",
    "unit": "En habitants",
    "answer": 59000
  },
  {
    "type": "POPULATION",
    "q": "Population de Valence ?",
    "unit": "En habitants",
    "answer": 64000
  },
  {
    "type": "POPULATION",
    "q": "Population de Troyes ?",
    "unit": "En habitants",
    "answer": 61000
  },
  {
    "type": "POPULATION",
    "q": "Population de Béziers ?",
    "unit": "En habitants",
    "answer": 78000
  },
  {
    "type": "POPULATION",
    "q": "Population de Villeneuve-d'Ascq ?",
    "unit": "En habitants",
    "answer": 63000
  },
  {
    "type": "POPULATION",
    "q": "Population de Épinal ?",
    "unit": "En habitants",
    "answer": 32000
  },
  {
    "type": "POPULATION",
    "q": "Population de Quimper ?",
    "unit": "En habitants",
    "answer": 63000
  },
  {
    "type": "POPULATION",
    "q": "Population de Brive-la-Gaillarde ?",
    "unit": "En habitants",
    "answer": 46000
  },
  {
    "type": "POPULATION",
    "q": "Population de Bourges ?",
    "unit": "En habitants",
    "answer": 64000
  },
  {
    "type": "POPULATION",
    "q": "Population de Charleville-Mézières ?",
    "unit": "En habitants",
    "answer": 46000
  },
  {
    "type": "POPULATION",
    "q": "Population de Angoulême ?",
    "unit": "En habitants",
    "answer": 41000
  },
  {
    "type": "POPULATION",
    "q": "Population de Niort ?",
    "unit": "En habitants",
    "answer": 58000
  },
  {
    "type": "POPULATION",
    "q": "Population de Chartres ?",
    "unit": "En habitants",
    "answer": 38000
  },
  {
    "type": "POPULATION",
    "q": "Population de Compiègne ?",
    "unit": "En habitants",
    "answer": 40000
  },
  {
    "type": "POPULATION",
    "q": "Population de Beauvais ?",
    "unit": "En habitants",
    "answer": 56000
  },
  {
    "type": "POPULATION",
    "q": "Population de Laval ?",
    "unit": "En habitants",
    "answer": 50000
  },
  {
    "type": "POPULATION",
    "q": "Population de Vannes ?",
    "unit": "En habitants",
    "answer": 54000
  },
  {
    "type": "POPULATION",
    "q": "Population de Lorient ?",
    "unit": "En habitants",
    "answer": 57000
  },
  {
    "type": "POPULATION",
    "q": "Population de Saint-Brieuc ?",
    "unit": "En habitants",
    "answer": 44000
  },
  {
    "type": "POPULATION",
    "q": "Population de Évreux ?",
    "unit": "En habitants",
    "answer": 48000
  },
  {
    "type": "POPULATION",
    "q": "Population de Blois ?",
    "unit": "En habitants",
    "answer": 46000
  },
  {
    "type": "POPULATION",
    "q": "Population de Mâcon ?",
    "unit": "En habitants",
    "answer": 34000
  },
  {
    "type": "POPULATION",
    "q": "Population de Belfort ?",
    "unit": "En habitants",
    "answer": 47000
  },
  {
    "type": "POPULATION",
    "q": "Population de Montauban ?",
    "unit": "En habitants",
    "answer": 62000
  },
  {
    "type": "POPULATION",
    "q": "Population de Albi ?",
    "unit": "En habitants",
    "answer": 49000
  },
  {
    "type": "POPULATION",
    "q": "Population de Castres ?",
    "unit": "En habitants",
    "answer": 41000
  },
  {
    "type": "POPULATION",
    "q": "Population de Agen ?",
    "unit": "En habitants",
    "answer": 33000
  },
  {
    "type": "POPULATION",
    "q": "Population de Périgueux ?",
    "unit": "En habitants",
    "answer": 29000
  },
  {
    "type": "POPULATION",
    "q": "Population de Bergerac ?",
    "unit": "En habitants",
    "answer": 27000
  },
  {
    "type": "POPULATION",
    "q": "Population de Carcassonne ?",
    "unit": "En habitants",
    "answer": 46000
  },
  {
    "type": "POPULATION",
    "q": "Population de Narbonne ?",
    "unit": "En habitants",
    "answer": 55000
  },
  {
    "type": "POPULATION",
    "q": "Population de Sète ?",
    "unit": "En habitants",
    "answer": 44000
  },
  {
    "type": "POPULATION",
    "q": "Population de Arles ?",
    "unit": "En habitants",
    "answer": 50000
  },
  {
    "type": "POPULATION",
    "q": "Population de Aubagne ?",
    "unit": "En habitants",
    "answer": 46000
  },
  {
    "type": "POPULATION",
    "q": "Population de Martigues ?",
    "unit": "En habitants",
    "answer": 48000
  },
  {
    "type": "POPULATION",
    "q": "Population de Fréjus ?",
    "unit": "En habitants",
    "answer": 55000
  },
  {
    "type": "POPULATION",
    "q": "Population de Cagnes-sur-Mer ?",
    "unit": "En habitants",
    "answer": 52000
  },
  {
    "type": "POPULATION",
    "q": "Population de Grasse ?",
    "unit": "En habitants",
    "answer": 50000
  },
  {
    "type": "POPULATION",
    "q": "Population de Hyères ?",
    "unit": "En habitants",
    "answer": 56000
  },
  {
    "type": "POPULATION",
    "q": "Population de La Seyne-sur-Mer ?",
    "unit": "En habitants",
    "answer": 65000
  },
  {
    "type": "POPULATION",
    "q": "Population de Valenciennes ?",
    "unit": "En habitants",
    "answer": 43000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de McDo en France ?",
    "unit": "En restaurants",
    "answer": 1560
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de boulangeries en France ?",
    "unit": "En boulangeries",
    "answer": 33000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de communes en France ?",
    "unit": "En communes",
    "answer": 35000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de pharmacies en France ?",
    "unit": "En pharmacies",
    "answer": 21000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de bars-tabac en France ?",
    "unit": "En bars-tabac",
    "answer": 24000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de hôpitaux en France ?",
    "unit": "En nombre",
    "answer": 36843
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de vélos en France ?",
    "unit": "En nombre",
    "answer": 3742
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de écoles en France ?",
    "unit": "En nombre",
    "answer": 29551
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de lycées en France ?",
    "unit": "En nombre",
    "answer": 13184
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de stations-service en France ?",
    "unit": "En nombre",
    "answer": 34783
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de fromages en France ?",
    "unit": "En nombre",
    "answer": 31532
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de musées en France ?",
    "unit": "En nombre",
    "answer": 26603
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de aéroports en France ?",
    "unit": "En nombre",
    "answer": 6050
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de théâtres en France ?",
    "unit": "En nombre",
    "answer": 3791
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de cinémas en France ?",
    "unit": "En nombre",
    "answer": 24126
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de gares en France ?",
    "unit": "En nombre",
    "answer": 19923
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de chats en France ?",
    "unit": "En nombre",
    "answer": 34326
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de pizzerias en France ?",
    "unit": "En nombre",
    "answer": 28445
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de voitures en France ?",
    "unit": "En nombre",
    "answer": 10941
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de chiens en France ?",
    "unit": "En nombre",
    "answer": 9803
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de collèges en France ?",
    "unit": "En nombre",
    "answer": 28582
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de supermarchés en France ?",
    "unit": "En nombre",
    "answer": 19961
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de librairies en France ?",
    "unit": "En nombre",
    "answer": 1189
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de mairies en France ?",
    "unit": "En mairies",
    "answer": 35000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de coiffeurs en France ?",
    "unit": "En coiffeurs",
    "answer": 85000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de garages automobiles en France ?",
    "unit": "En garages",
    "answer": 40000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'agences bancaires en France ?",
    "unit": "En agences",
    "answer": 38000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de casernes de pompiers en France ?",
    "unit": "En casernes",
    "answer": 7000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de commissariats de police en France ?",
    "unit": "En commissariats",
    "answer": 1800
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de gendarmeries en France ?",
    "unit": "En gendarmeries",
    "answer": 3100
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de campings en France ?",
    "unit": "En campings",
    "answer": 7700
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'hôtels en France ?",
    "unit": "En hôtels",
    "answer": 17000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de restaurants en France ?",
    "unit": "En restaurants",
    "answer": 175000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de cafés en France ?",
    "unit": "En cafés",
    "answer": 35000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de fleuristes en France ?",
    "unit": "En fleuristes",
    "answer": 13000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'opticiens en France ?",
    "unit": "En opticiens",
    "answer": 12000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de dentistes en France ?",
    "unit": "En dentistes",
    "answer": 43000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de médecins généralistes en France ?",
    "unit": "En médecins",
    "answer": 100000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de vétérinaires en France ?",
    "unit": "En vétérinaires",
    "answer": 20000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de notaires en France ?",
    "unit": "En notaires",
    "answer": 17000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'avocats en France ?",
    "unit": "En avocats",
    "answer": 75000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de plombiers en France ?",
    "unit": "En plombiers",
    "answer": 90000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'électriciens en France ?",
    "unit": "En électriciens",
    "answer": 100000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de boucheries en France ?",
    "unit": "En boucheries",
    "answer": 18000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de poissonneries en France ?",
    "unit": "En poissonneries",
    "answer": 3000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de pâtisseries en France ?",
    "unit": "En pâtisseries",
    "answer": 6000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de fromageries en France ?",
    "unit": "En fromageries",
    "answer": 3500
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de cavistes en France ?",
    "unit": "En cavistes",
    "answer": 6000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de piscines municipales en France ?",
    "unit": "En piscines",
    "answer": 4000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de terrains de tennis en France ?",
    "unit": "En terrains",
    "answer": 33000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de terrains de foot en France ?",
    "unit": "En terrains",
    "answer": 30000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de stades de plus de 20 000 places en France ?",
    "unit": "En stades",
    "answer": 30
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'aires d'autoroute en France ?",
    "unit": "En aires",
    "answer": 400
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de ponts à Paris ?",
    "unit": "En ponts",
    "answer": 37
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de stations de métro à Paris ?",
    "unit": "En stations",
    "answer": 308
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de lignes de métro à Paris ?",
    "unit": "En lignes",
    "answer": 16
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'arrondissements à Paris ?",
    "unit": "En arrondissements",
    "answer": 20
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de fontaines à Paris ?",
    "unit": "En fontaines",
    "answer": 1200
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de parcs et jardins à Paris ?",
    "unit": "En parcs",
    "answer": 500
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'arbres à Paris ?",
    "unit": "En arbres",
    "answer": 200000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de bancs publics à Paris ?",
    "unit": "En bancs",
    "answer": 30000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de vélos en libre-service à Paris ?",
    "unit": "En vélos",
    "answer": 20000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de bornes de recharge électrique en France ?",
    "unit": "En bornes",
    "answer": 130000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'éoliennes en France ?",
    "unit": "En éoliennes",
    "answer": 9000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de réacteurs nucléaires en France ?",
    "unit": "En réacteurs",
    "answer": 56
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de barrages hydroélectriques en France ?",
    "unit": "En barrages",
    "answer": 2300
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de communes de plus de 100 000 habitants en France ?",
    "unit": "En communes",
    "answer": 40
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de départements en France ?",
    "unit": "En départements",
    "answer": 101
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de régions en France ?",
    "unit": "En régions",
    "answer": 18
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'universités en France ?",
    "unit": "En universités",
    "answer": 70
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de grandes écoles en France ?",
    "unit": "En écoles",
    "answer": 250
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de crèches en France ?",
    "unit": "En crèches",
    "answer": 15000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'EHPAD en France ?",
    "unit": "En EHPAD",
    "answer": 7500
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de terrains de golf en France ?",
    "unit": "En terrains",
    "answer": 700
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de plages surveillées en France l'été ?",
    "unit": "En plages",
    "answer": 1500
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de fast-foods en France ?",
    "unit": "En fast-foods",
    "answer": 45000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de distributeurs automatiques de billets en France ?",
    "unit": "En distributeurs",
    "answer": 50000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de bureaux de poste en France ?",
    "unit": "En bureaux",
    "answer": 17000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de mosquées en France ?",
    "unit": "En mosquées",
    "answer": 2500
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'églises en France ?",
    "unit": "En églises",
    "answer": 45000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de synagogues en France ?",
    "unit": "En synagogues",
    "answer": 300
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de temples protestants en France ?",
    "unit": "En temples",
    "answer": 1000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de cimetières en France ?",
    "unit": "En cimetières",
    "answer": 40000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de gîtes ruraux en France ?",
    "unit": "En gîtes",
    "answer": 45000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de chambres d'hôtes en France ?",
    "unit": "En chambres",
    "answer": 40000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de parcs d'attractions en France ?",
    "unit": "En parcs",
    "answer": 300
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de zoos en France ?",
    "unit": "En zoos",
    "answer": 300
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'aquariums en France ?",
    "unit": "En aquariums",
    "answer": 25
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de bibliothèques municipales en France ?",
    "unit": "En bibliothèques",
    "answer": 16000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de conservatoires de musique en France ?",
    "unit": "En conservatoires",
    "answer": 400
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de salles de sport (fitness) en France ?",
    "unit": "En salles",
    "answer": 5500
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de piscines privées en France ?",
    "unit": "En piscines",
    "answer": 3200000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de jours fériés en France ?",
    "unit": "En jours",
    "answer": 11
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'AOC/AOP fromagères en France ?",
    "unit": "En AOC",
    "answer": 46
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de vins AOC en France ?",
    "unit": "En AOC",
    "answer": 363
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de châteaux en France ?",
    "unit": "En châteaux",
    "answer": 45000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de phares en France ?",
    "unit": "En phares",
    "answer": 150
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de départs de trains par jour gare du Nord ?",
    "unit": "En trains",
    "answer": 700
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de correspondances possibles à la gare de Lyon-Part-Dieu ?",
    "unit": "En quais",
    "answer": 22
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de bureaux de tabac en France ?",
    "unit": "En bureaux",
    "answer": 24000
  },
  {
    "type": "FOOD",
    "q": "Poids d'un kebab complet avec frites ?",
    "unit": "En g",
    "answer": 450
  },
  {
    "type": "FOOD",
    "q": "Calories d'un menu Big Mac complet (Big Mac + frites M + Coca M) ?",
    "unit": "En kcal",
    "answer": 1080
  },
  {
    "type": "FOOD",
    "q": "Prix moyen d'un kebab en France ?",
    "unit": "En €",
    "answer": 7
  },
  {
    "type": "FOOD",
    "q": "Poids d'une baguette tradition ?",
    "unit": "En g",
    "answer": 250
  },
  {
    "type": "FOOD",
    "q": "Calories d'une canette de Coca 33cl ?",
    "unit": "En kcal",
    "answer": 139
  },
  {
    "type": "FOOD",
    "q": "Poids d'un steak de Big Mac (1 steak) ?",
    "unit": "En g",
    "answer": 45
  },
  {
    "type": "FOOD",
    "q": "Calories d'une pizza 4 fromages entière 30cm ?",
    "unit": "En kcal",
    "answer": 1200
  },
  {
    "type": "FOOD",
    "q": "Prix d'une pizza margherita à emporter ?",
    "unit": "En €",
    "answer": 9
  },
  {
    "type": "FOOD",
    "q": "Poids d'un croissant de boulangerie ?",
    "unit": "En g",
    "answer": 65
  },
  {
    "type": "FOOD",
    "q": "Calories d'un croissant au beurre ?",
    "unit": "En kcal",
    "answer": 240
  },
  {
    "type": "FOOD",
    "q": "Poids d'un Big Mac ?",
    "unit": "En g",
    "answer": 479
  },
  {
    "type": "FOOD",
    "q": "Poids d'un tacos 3 viandes ?",
    "unit": "En g",
    "answer": 904
  },
  {
    "type": "FOOD",
    "q": "Poids d'un pain au chocolat ?",
    "unit": "En g",
    "answer": 407
  },
  {
    "type": "FOOD",
    "q": "Poids d'un kebab poulet complet avec frites à Paris ?",
    "unit": "En g",
    "answer": 182
  },
  {
    "type": "FOOD",
    "q": "Poids d'un croissant ?",
    "unit": "En g",
    "answer": 137
  },
  {
    "type": "FOOD",
    "q": "Population de Paris ?",
    "unit": "En habitants",
    "answer": 1000
  },
  {
    "type": "FOOD",
    "q": "Poids d'une pomme moyenne ?",
    "unit": "En g",
    "answer": 150
  },
  {
    "type": "FOOD",
    "q": "Poids d'une banane moyenne ?",
    "unit": "En g",
    "answer": 120
  },
  {
    "type": "FOOD",
    "q": "Poids d'un oeuf moyen (calibre M) ?",
    "unit": "En g",
    "answer": 60
  },
  {
    "type": "FOOD",
    "q": "Calories d'une pomme ?",
    "unit": "En kcal",
    "answer": 80
  },
  {
    "type": "FOOD",
    "q": "Calories d'une banane ?",
    "unit": "En kcal",
    "answer": 105
  },
  {
    "type": "FOOD",
    "q": "Calories d'un oeuf dur ?",
    "unit": "En kcal",
    "answer": 78
  },
  {
    "type": "FOOD",
    "q": "Poids d'un yaourt nature ?",
    "unit": "En g",
    "answer": 125
  },
  {
    "type": "FOOD",
    "q": "Calories d'un yaourt nature ?",
    "unit": "En kcal",
    "answer": 60
  },
  {
    "type": "FOOD",
    "q": "Poids d'une part de pizza ?",
    "unit": "En g",
    "answer": 120
  },
  {
    "type": "FOOD",
    "q": "Calories d'une part de pizza ?",
    "unit": "En kcal",
    "answer": 285
  },
  {
    "type": "FOOD",
    "q": "Poids d'un hamburger maison ?",
    "unit": "En g",
    "answer": 200
  },
  {
    "type": "FOOD",
    "q": "Calories d'un Whopper ?",
    "unit": "En kcal",
    "answer": 660
  },
  {
    "type": "FOOD",
    "q": "Poids d'un Whopper ?",
    "unit": "En g",
    "answer": 291
  },
  {
    "type": "FOOD",
    "q": "Poids d'une plaquette de beurre ?",
    "unit": "En g",
    "answer": 250
  },
  {
    "type": "FOOD",
    "q": "Calories pour 100g de chocolat noir ?",
    "unit": "En kcal",
    "answer": 550
  },
  {
    "type": "FOOD",
    "q": "Poids d'une tablette de chocolat ?",
    "unit": "En g",
    "answer": 100
  },
  {
    "type": "FOOD",
    "q": "Calories d'une tablette de chocolat au lait ?",
    "unit": "En kcal",
    "answer": 530
  },
  {
    "type": "FOOD",
    "q": "Poids d'un pot de yaourt grec ?",
    "unit": "En g",
    "answer": 150
  },
  {
    "type": "FOOD",
    "q": "Calories d'un McFlurry Oreo ?",
    "unit": "En kcal",
    "answer": 340
  },
  {
    "type": "FOOD",
    "q": "Poids d'un McFlurry Oreo ?",
    "unit": "En g",
    "answer": 219
  },
  {
    "type": "FOOD",
    "q": "Poids d'une part de tarte aux pommes ?",
    "unit": "En g",
    "answer": 130
  },
  {
    "type": "FOOD",
    "q": "Calories d'une part de tarte aux pommes ?",
    "unit": "En kcal",
    "answer": 300
  },
  {
    "type": "FOOD",
    "q": "Poids d'un avocat moyen ?",
    "unit": "En g",
    "answer": 200
  },
  {
    "type": "FOOD",
    "q": "Calories d'un avocat ?",
    "unit": "En kcal",
    "answer": 240
  },
  {
    "type": "FOOD",
    "q": "Poids d'une pomme de terre moyenne ?",
    "unit": "En g",
    "answer": 150
  },
  {
    "type": "FOOD",
    "q": "Calories pour 100g de pommes de terre ?",
    "unit": "En kcal",
    "answer": 77
  },
  {
    "type": "FOOD",
    "q": "Poids d'un steak haché 15% MG ?",
    "unit": "En g",
    "answer": 100
  },
  {
    "type": "FOOD",
    "q": "Calories d'un steak haché 15% MG ?",
    "unit": "En kcal",
    "answer": 215
  },
  {
    "type": "FOOD",
    "q": "Poids d'un filet de poulet ?",
    "unit": "En g",
    "answer": 150
  },
  {
    "type": "FOOD",
    "q": "Calories d'un filet de poulet grillé ?",
    "unit": "En kcal",
    "answer": 165
  },
  {
    "type": "FOOD",
    "q": "Poids d'un pavé de saumon ?",
    "unit": "En g",
    "answer": 150
  },
  {
    "type": "FOOD",
    "q": "Calories d'un pavé de saumon ?",
    "unit": "En kcal",
    "answer": 280
  },
  {
    "type": "FOOD",
    "q": "Poids d'une part de camembert (30g) ?",
    "unit": "En g",
    "answer": 30
  },
  {
    "type": "FOOD",
    "q": "Calories d'une part de camembert (30g) ?",
    "unit": "En kcal",
    "answer": 95
  },
  {
    "type": "FOOD",
    "q": "Poids d'un bol de céréales ?",
    "unit": "En g",
    "answer": 40
  },
  {
    "type": "FOOD",
    "q": "Calories d'un bol de céréales avec lait ?",
    "unit": "En kcal",
    "answer": 250
  },
  {
    "type": "FOOD",
    "q": "Calories d'une canette de Red Bull 25cl ?",
    "unit": "En kcal",
    "answer": 115
  },
  {
    "type": "FOOD",
    "q": "Poids d'un cornet de glace 2 boules ?",
    "unit": "En g",
    "answer": 150
  },
  {
    "type": "FOOD",
    "q": "Calories d'un cornet de glace 2 boules ?",
    "unit": "En kcal",
    "answer": 250
  },
  {
    "type": "FOOD",
    "q": "Calories d'un paquet de chips 150g entier ?",
    "unit": "En kcal",
    "answer": 800
  },
  {
    "type": "FOOD",
    "q": "Poids d'une part de quiche lorraine ?",
    "unit": "En g",
    "answer": 150
  },
  {
    "type": "FOOD",
    "q": "Calories d'une part de quiche lorraine ?",
    "unit": "En kcal",
    "answer": 400
  },
  {
    "type": "FOOD",
    "q": "Poids d'un croque-monsieur ?",
    "unit": "En g",
    "answer": 150
  },
  {
    "type": "FOOD",
    "q": "Calories d'un croque-monsieur ?",
    "unit": "En kcal",
    "answer": 400
  },
  {
    "type": "FOOD",
    "q": "Poids d'une part de lasagnes ?",
    "unit": "En g",
    "answer": 300
  },
  {
    "type": "FOOD",
    "q": "Calories d'une part de lasagnes ?",
    "unit": "En kcal",
    "answer": 400
  },
  {
    "type": "FOOD",
    "q": "Poids d'un bol de soupe ?",
    "unit": "En g",
    "answer": 250
  },
  {
    "type": "FOOD",
    "q": "Calories d'un bol de soupe de légumes ?",
    "unit": "En kcal",
    "answer": 100
  },
  {
    "type": "FOOD",
    "q": "Poids d'une portion de frites (fast-food M) ?",
    "unit": "En g",
    "answer": 115
  },
  {
    "type": "FOOD",
    "q": "Calories d'une portion de frites moyenne ?",
    "unit": "En kcal",
    "answer": 340
  },
  {
    "type": "FOOD",
    "q": "Calories pour 2 tranches de pain de mie ?",
    "unit": "En kcal",
    "answer": 130
  },
  {
    "type": "FOOD",
    "q": "Poids d'un pot de confiture ?",
    "unit": "En g",
    "answer": 370
  },
  {
    "type": "FOOD",
    "q": "Calories pour une cuillère de confiture (15g) ?",
    "unit": "En kcal",
    "answer": 40
  },
  {
    "type": "FOOD",
    "q": "Calories pour 4 biscuits petit-beurre ?",
    "unit": "En kcal",
    "answer": 120
  },
  {
    "type": "FOOD",
    "q": "Prix d'un menu Subway 30cm avec boisson ?",
    "unit": "En €",
    "answer": 12
  },
  {
    "type": "FOOD",
    "q": "Prix d'une salade composée en snack ?",
    "unit": "En €",
    "answer": 8
  },
  {
    "type": "FOOD",
    "q": "Prix d'un plateau sushi 12 pièces ?",
    "unit": "En €",
    "answer": 12
  },
  {
    "type": "FOOD",
    "q": "Poids d'un plateau sushi 12 pièces ?",
    "unit": "En g",
    "answer": 300
  },
  {
    "type": "FOOD",
    "q": "Calories d'un plateau sushi 12 pièces (saumon/avocat) ?",
    "unit": "En kcal",
    "answer": 450
  },
  {
    "type": "FOOD",
    "q": "Poids d'un bibimbap (bol coréen) ?",
    "unit": "En g",
    "answer": 500
  },
  {
    "type": "FOOD",
    "q": "Calories d'un bibimbap ?",
    "unit": "En kcal",
    "answer": 550
  },
  {
    "type": "FOOD",
    "q": "Poids d'un burrito ?",
    "unit": "En g",
    "answer": 400
  },
  {
    "type": "FOOD",
    "q": "Calories d'un burrito poulet ?",
    "unit": "En kcal",
    "answer": 650
  },
  {
    "type": "FOOD",
    "q": "Poids d'un donut glacé ?",
    "unit": "En g",
    "answer": 60
  },
  {
    "type": "FOOD",
    "q": "Calories d'un donut glacé ?",
    "unit": "En kcal",
    "answer": 250
  },
  {
    "type": "FOOD",
    "q": "Poids d'un cookie moyen ?",
    "unit": "En g",
    "answer": 50
  },
  {
    "type": "FOOD",
    "q": "Calories d'un cookie aux pépites de chocolat ?",
    "unit": "En kcal",
    "answer": 220
  },
  {
    "type": "FOOD",
    "q": "Poids d'une part de brownie ?",
    "unit": "En g",
    "answer": 60
  },
  {
    "type": "FOOD",
    "q": "Calories d'une part de brownie ?",
    "unit": "En kcal",
    "answer": 280
  },
  {
    "type": "FOOD",
    "q": "Poids d'un macaron ?",
    "unit": "En g",
    "answer": 15
  },
  {
    "type": "FOOD",
    "q": "Calories d'un macaron ?",
    "unit": "En kcal",
    "answer": 70
  },
  {
    "type": "FOOD",
    "q": "Poids d'un pain au raisin ?",
    "unit": "En g",
    "answer": 80
  },
  {
    "type": "FOOD",
    "q": "Calories d'un pain au raisin ?",
    "unit": "En kcal",
    "answer": 290
  },
  {
    "type": "FOOD",
    "q": "Poids d'une religieuse au chocolat ?",
    "unit": "En g",
    "answer": 100
  },
  {
    "type": "FOOD",
    "q": "Calories d'une religieuse au chocolat ?",
    "unit": "En kcal",
    "answer": 320
  },
  {
    "type": "FOOD",
    "q": "Poids d'un éclair au chocolat ?",
    "unit": "En g",
    "answer": 90
  },
  {
    "type": "FOOD",
    "q": "Calories d'un éclair au chocolat ?",
    "unit": "En kcal",
    "answer": 300
  },
  {
    "type": "FOOD",
    "q": "Poids d'un paquet de spaghetti 500g ?",
    "unit": "En g",
    "answer": 500
  },
  {
    "type": "FOOD",
    "q": "Calories pour 100g de spaghetti crus ?",
    "unit": "En kcal",
    "answer": 350
  },
  {
    "type": "FOOD",
    "q": "Poids d'une part de saumon fumé (4 tranches) ?",
    "unit": "En g",
    "answer": 100
  },
  {
    "type": "FOOD",
    "q": "Calories pour 100g de saumon fumé ?",
    "unit": "En kcal",
    "answer": 180
  },
  {
    "type": "FOOD",
    "q": "Poids d'un pot de houmous ?",
    "unit": "En g",
    "answer": 200
  },
  {
    "type": "FOOD",
    "q": "Calories pour 100g de houmous ?",
    "unit": "En kcal",
    "answer": 250
  },
  {
    "type": "FOOD",
    "q": "Poids d'une part de far breton ?",
    "unit": "En g",
    "answer": 100
  },
  {
    "type": "TEMPS",
    "q": "Durée du film Titanic ?",
    "unit": "En minutes",
    "answer": 195
  },
  {
    "type": "TEMPS",
    "q": "Temps de cuisson d'un oeuf dur ?",
    "unit": "En minutes",
    "answer": 10
  },
  {
    "type": "TEMPS",
    "q": "Trajet Paris - Lyon en TGV ?",
    "unit": "En minutes",
    "answer": 115
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un match de foot pro (temps réglementaire) ?",
    "unit": "En minutes",
    "answer": 90
  },
  {
    "type": "TEMPS",
    "q": "Temps pour faire Paris - Marseille en voiture ?",
    "unit": "En heures",
    "answer": 7
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'une sieste efficace ?",
    "unit": "En minutes",
    "answer": 20
  },
  {
    "type": "TEMPS",
    "q": "Temps pour cuire une pizza au four ?",
    "unit": "En minutes",
    "answer": 12
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un vol Paris - New York ?",
    "unit": "En heures",
    "answer": 8
  },
  {
    "type": "TEMPS",
    "q": "Durée du Tour de France (en jours) ?",
    "unit": "En jours",
    "answer": 23
  },
  {
    "type": "TEMPS",
    "q": "Temps de cuisson des pâtes al dente ?",
    "unit": "En minutes",
    "answer": 9
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un épisode de série TV standard ?",
    "unit": "En minutes",
    "answer": 45
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une pub télé standard ?",
    "unit": "En secondes",
    "answer": 30
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'une chanson pop ?",
    "unit": "En minutes",
    "answer": 3
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un cours au collège ?",
    "unit": "En minutes",
    "answer": 55
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une mi-temps de foot ?",
    "unit": "En minutes",
    "answer": 45
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un quart-temps de basket NBA ?",
    "unit": "En minutes",
    "answer": 12
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une période de hockey sur glace ?",
    "unit": "En minutes",
    "answer": 20
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un marathon (temps moyen amateur) ?",
    "unit": "En heures",
    "answer": 4
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un semi-marathon (temps moyen amateur) ?",
    "unit": "En heures",
    "answer": 2
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'un accouchement (premier enfant) ?",
    "unit": "En heures",
    "answer": 8
  },
  {
    "type": "TEMPS",
    "q": "Durée de sommeil recommandée pour un adulte ?",
    "unit": "En heures",
    "answer": 8
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un cycle de sommeil ?",
    "unit": "En minutes",
    "answer": 90
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une grossesse humaine ?",
    "unit": "En semaines",
    "answer": 40
  },
  {
    "type": "TEMPS",
    "q": "Durée de charge complète d'un iPhone ?",
    "unit": "En minutes",
    "answer": 90
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un cycle de lave-linge standard ?",
    "unit": "En minutes",
    "answer": 90
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un cycle de lave-vaisselle standard ?",
    "unit": "En minutes",
    "answer": 120
  },
  {
    "type": "TEMPS",
    "q": "Durée de cuisson d'un riz blanc ?",
    "unit": "En minutes",
    "answer": 12
  },
  {
    "type": "TEMPS",
    "q": "Durée de cuisson d'une pomme de terre à l'eau ?",
    "unit": "En minutes",
    "answer": 20
  },
  {
    "type": "TEMPS",
    "q": "Durée de cuisson d'un poulet entier au four ?",
    "unit": "En minutes",
    "answer": 90
  },
  {
    "type": "TEMPS",
    "q": "Durée de décongélation d'une pizza au micro-ondes ?",
    "unit": "En minutes",
    "answer": 5
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un trajet Paris - Marseille en TGV ?",
    "unit": "En heures",
    "answer": 3
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un trajet Paris - Bordeaux en TGV ?",
    "unit": "En heures",
    "answer": 2
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un trajet Paris - Londres en Eurostar ?",
    "unit": "En heures",
    "answer": 2
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un trajet Paris - Bruxelles en train ?",
    "unit": "En heures",
    "answer": 1
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un vol Paris - Tokyo ?",
    "unit": "En heures",
    "answer": 12
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un vol Paris - Rome ?",
    "unit": "En heures",
    "answer": 2
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un vol Paris - Dakar ?",
    "unit": "En heures",
    "answer": 6
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une éclipse solaire totale (phase totale) ?",
    "unit": "En minutes",
    "answer": 4
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une rotation de la Terre sur elle-même ?",
    "unit": "En heures",
    "answer": 24
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une révolution de la Terre autour du Soleil ?",
    "unit": "En jours",
    "answer": 365
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un mandat présidentiel français ?",
    "unit": "En années",
    "answer": 5
  },
  {
    "type": "TEMPS",
    "q": "Durée légale hebdomadaire du travail en France ?",
    "unit": "En heures",
    "answer": 35
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'une pause déjeuner en France ?",
    "unit": "En minutes",
    "answer": 45
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'un trajet domicile-travail en France ?",
    "unit": "En minutes",
    "answer": 30
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne passée sur les réseaux sociaux par jour (France) ?",
    "unit": "En minutes",
    "answer": 90
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'un appel téléphonique perso ?",
    "unit": "En minutes",
    "answer": 8
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un concert de musique standard ?",
    "unit": "En heures",
    "answer": 2
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un entracte au théâtre ?",
    "unit": "En minutes",
    "answer": 15
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un match de rugby (temps réglementaire) ?",
    "unit": "En minutes",
    "answer": 80
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un match de handball ?",
    "unit": "En minutes",
    "answer": 60
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un match de volley (moyenne) ?",
    "unit": "En minutes",
    "answer": 90
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un combat de boxe professionnel (12 rounds) ?",
    "unit": "En minutes",
    "answer": 36
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un round de boxe ?",
    "unit": "En minutes",
    "answer": 3
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une course de F1 (Grand Prix) ?",
    "unit": "En heures",
    "answer": 2
  },
  {
    "type": "TEMPS",
    "q": "Durée des 24h du Mans ?",
    "unit": "En heures",
    "answer": 24
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une étape moyenne du Tour de France ?",
    "unit": "En heures",
    "answer": 4
  },
  {
    "type": "TEMPS",
    "q": "Durée de la phase finale de la Coupe du Monde de foot ?",
    "unit": "En jours",
    "answer": 30
  },
  {
    "type": "TEMPS",
    "q": "Durée de vie moyenne d'un smartphone avant remplacement ?",
    "unit": "En années",
    "answer": 3
  },
  {
    "type": "TEMPS",
    "q": "Durée de recharge d'une voiture électrique (borne rapide) ?",
    "unit": "En minutes",
    "answer": 30
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'un plein d'essence (temps à la pompe) ?",
    "unit": "En minutes",
    "answer": 5
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'une douche ?",
    "unit": "En minutes",
    "answer": 8
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'un bain ?",
    "unit": "En minutes",
    "answer": 20
  },
  {
    "type": "TEMPS",
    "q": "Durée nécessaire pour qu'un cheveu pousse d'1cm ?",
    "unit": "En jours",
    "answer": 30
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'un rhume ?",
    "unit": "En jours",
    "answer": 7
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'une gueule de bois ?",
    "unit": "En heures",
    "answer": 24
  },
  {
    "type": "TEMPS",
    "q": "Durée de digestion d'un repas complet ?",
    "unit": "En heures",
    "answer": 4
  },
  {
    "type": "TEMPS",
    "q": "Durée d'effet de la caféine dans le corps ?",
    "unit": "En heures",
    "answer": 5
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un cycle de feu tricolore ?",
    "unit": "En secondes",
    "answer": 90
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un cours de yoga standard ?",
    "unit": "En minutes",
    "answer": 60
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne des publicités avant un film au cinéma ?",
    "unit": "En minutes",
    "answer": 15
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un trajet en avion Paris - Nice ?",
    "unit": "En heures",
    "answer": 1
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une traversée en bateau Marseille - Corse ?",
    "unit": "En heures",
    "answer": 10
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une traversée Calais - Douvres en ferry ?",
    "unit": "En minutes",
    "answer": 90
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un trajet en métro parisien (ligne 1 bout en bout) ?",
    "unit": "En minutes",
    "answer": 35
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'attente aux urgences en France ?",
    "unit": "En heures",
    "answer": 3
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une consultation chez le médecin généraliste ?",
    "unit": "En minutes",
    "answer": 15
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un cours de conduite ?",
    "unit": "En minutes",
    "answer": 60
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne pour obtenir le permis de conduire (code + conduite) ?",
    "unit": "En mois",
    "answer": 6
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'une averse d'orage ?",
    "unit": "En minutes",
    "answer": 30
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'un été en France (météorologique) ?",
    "unit": "En jours",
    "answer": 92
  },
  {
    "type": "TEMPS",
    "q": "Durée du jour le plus long de l'année à Paris ?",
    "unit": "En heures",
    "answer": 16
  },
  {
    "type": "TEMPS",
    "q": "Durée du jour le plus court de l'année à Paris ?",
    "unit": "En heures",
    "answer": 8
  },
  {
    "type": "TEMPS",
    "q": "Durée d'incubation d'un oeuf de poule ?",
    "unit": "En jours",
    "answer": 21
  },
  {
    "type": "TEMPS",
    "q": "Durée de gestation d'une vache ?",
    "unit": "En mois",
    "answer": 9
  },
  {
    "type": "TEMPS",
    "q": "Durée de gestation d'une souris ?",
    "unit": "En jours",
    "answer": 20
  },
  {
    "type": "TEMPS",
    "q": "Durée de gestation d'un éléphant ?",
    "unit": "En mois",
    "answer": 22
  },
  {
    "type": "TEMPS",
    "q": "Durée d'autonomie d'un smartphone en usage normal ?",
    "unit": "En heures",
    "answer": 15
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une charge complète sur prise domestique (voiture électrique) ?",
    "unit": "En heures",
    "answer": 10
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'une réunion de travail ?",
    "unit": "En minutes",
    "answer": 45
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'une pause café au travail ?",
    "unit": "En minutes",
    "answer": 10
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un trajet Paris - Deauville en voiture ?",
    "unit": "En heures",
    "answer": 2
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un trajet Lyon - Genève en train ?",
    "unit": "En heures",
    "answer": 2
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un cycle de sèche-linge ?",
    "unit": "En minutes",
    "answer": 60
  },
  {
    "type": "TEMPS",
    "q": "Durée de vie d'une ampoule LED ?",
    "unit": "En années",
    "answer": 15
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'une session de jeu vidéo ?",
    "unit": "En minutes",
    "answer": 45
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un cours de piscine (leçon enfant) ?",
    "unit": "En minutes",
    "answer": 30
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'un cours de danse ?",
    "unit": "En minutes",
    "answer": 60
  },
  {
    "type": "TEMPS",
    "q": "Durée d'attente moyenne pour un rendez-vous chez le dentiste ?",
    "unit": "En jours",
    "answer": 30
  },
  {
    "type": "TEMPS",
    "q": "Durée moyenne d'un cours de sport collectif en salle ?",
    "unit": "En minutes",
    "answer": 45
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une pause publicitaire pendant un match de foot télévisé ?",
    "unit": "En minutes",
    "answer": 3
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Emma sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 6038
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Léo sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1712
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Jade sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1004
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Gabriel sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3053
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Louis sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2806
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Jules sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2628
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Hugo sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1943
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Adam sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1639
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Louise sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 6343
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Alice sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5267
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Raphaël sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1512
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Maël sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5637
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Chloé sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 4256
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Léa sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1060
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Noah sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1044
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Lucas sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1567
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Mia sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2591
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Ethan sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2705
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Inès sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 4939
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Sacha sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5731
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Ambre sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1017
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Aaron sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5397
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Lina sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2428
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Rose sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 6123
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Anna sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5264
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Mila sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 4236
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Eden sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2605
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Liam sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 4479
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Paul sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5627
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Arthur sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3078
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Tom sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 853
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Noé sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2107
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Sofia sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 4262
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Léon sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3587
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Nina sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3076
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Eva sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2073
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Julia sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2563
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Léna sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3557
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Enzo sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1637
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Théo sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1559
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Nathan sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3912
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Elena sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1592
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Camille sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3740
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Zoé sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3617
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Malo sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5745
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Iris sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2966
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Margot sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1155
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Juliette sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 4563
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Romy sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5192
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Victor sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1822
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Mathis sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3900
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Marius sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1445
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Augustin sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5322
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Gaspard sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3201
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Ibrahim sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5949
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Mohamed sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5866
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Youssef sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5529
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Lyam sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2375
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Tiago sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1369
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Ilyes sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1175
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Elio sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 6217
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Milo sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2666
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Soan sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1453
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Ilan sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2707
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Noa sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1627
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Léonie sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3913
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Agathe sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3077
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Jeanne sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 4514
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Gabrielle sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 6007
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Lou sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3788
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Manon sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2132
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Clémence sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3832
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Apolline sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3710
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Constance sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2516
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Garance sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 6290
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Capucine sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2987
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Victoire sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 6399
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Madeleine sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 6108
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Joséphine sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1384
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Suzanne sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5790
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Colette sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 6001
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Simone sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2201
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Yvette sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5175
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Monique sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2805
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Christiane sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2138
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Françoise sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 4586
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Brigitte sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3908
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Sylvie sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3011
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Martine sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 6042
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Nicole sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 6437
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Isabelle sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 5362
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Nathalie sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2599
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Sophie sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 6408
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Caroline sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3456
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Aurélie sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1258
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Émilie sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 2676
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Mélanie sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 1062
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Laetitia sont nés en France en 2023 ?",
    "unit": "En naissances",
    "answer": 3384
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Léo sont nés à Toulouse en 2023 ?",
    "unit": "En naissances",
    "answer": 390
  },
  {
    "type": "PRÉNOM",
    "q": "Combien de bébés prénommés Alice sont nés à Metz en 2023 ?",
    "unit": "En naissances",
    "answer": 326
  },
  {
    "type": "CORPS",
    "q": "Combien d'os possède un adulte ?",
    "unit": "En os",
    "answer": 206
  },
  {
    "type": "CORPS",
    "q": "Combien d'os possède un bébé à la naissance ?",
    "unit": "En os",
    "answer": 300
  },
  {
    "type": "CORPS",
    "q": "Combien de dents possède un adulte avec dents de sagesse ?",
    "unit": "En dents",
    "answer": 32
  },
  {
    "type": "CORPS",
    "q": "Combien de muscles possède le corps humain ?",
    "unit": "En muscles",
    "answer": 639
  },
  {
    "type": "CORPS",
    "q": "Combien de fois ton coeur bat-il par jour en moyenne ?",
    "unit": "En battements",
    "answer": 100000
  },
  {
    "type": "CORPS",
    "q": "Au repos, combien de battements par minute pour un adulte ?",
    "unit": "En battements/minute",
    "answer": 70
  },
  {
    "type": "CORPS",
    "q": "Combien de litres de sang dans un adulte moyen ?",
    "unit": "En litres",
    "answer": 5
  },
  {
    "type": "CORPS",
    "q": "Poids moyen du cerveau d'un adulte ?",
    "unit": "En g",
    "answer": 1400
  },
  {
    "type": "CORPS",
    "q": "Longueur de l'intestin grêle ?",
    "unit": "En cm",
    "answer": 600
  },
  {
    "type": "CORPS",
    "q": "Longueur du gros intestin ?",
    "unit": "En cm",
    "answer": 150
  },
  {
    "type": "CORPS",
    "q": "Surface totale de la peau humaine ?",
    "unit": "En m2",
    "answer": 2
  },
  {
    "type": "CORPS",
    "q": "Nombre de cheveux sur une tête humaine en moyenne ?",
    "unit": "En cheveux",
    "answer": 100000
  },
  {
    "type": "CORPS",
    "q": "Nombre de litres d'air respirés par jour ?",
    "unit": "En litres",
    "answer": 11000
  },
  {
    "type": "CORPS",
    "q": "Poids du foie adulte ?",
    "unit": "En g",
    "answer": 1500
  },
  {
    "type": "CORPS",
    "q": "Poids du coeur adulte ?",
    "unit": "En g",
    "answer": 300
  },
  {
    "type": "CORPS",
    "q": "Longueur totale des vaisseaux sanguins ?",
    "unit": "En km",
    "answer": 100000
  },
  {
    "type": "CORPS",
    "q": "Nombre de globules rouges par mm3 de sang ?",
    "unit": "En millions",
    "answer": 5
  },
  {
    "type": "CORPS",
    "q": "Durée de vie d'un globule rouge ?",
    "unit": "En jours",
    "answer": 120
  },
  {
    "type": "CORPS",
    "q": "Nombre de papilles gustatives sur la langue ?",
    "unit": "En papilles",
    "answer": 8000
  },
  {
    "type": "CORPS",
    "q": "Acidité de l'estomac (pH moyen) ?",
    "unit": "En pH",
    "answer": 2
  },
  {
    "type": "CORPS",
    "q": "Température corporelle normale ?",
    "unit": "En °C",
    "answer": 37
  },
  {
    "type": "CORPS",
    "q": "Pression artérielle systolique normale ?",
    "unit": "En mmHg",
    "answer": 120
  },
  {
    "type": "CORPS",
    "q": "Nombre de litres d'eau dans le corps humain (70kg) ?",
    "unit": "En litres",
    "answer": 42
  },
  {
    "type": "CORPS",
    "q": "Poids du squelette humain ?",
    "unit": "En kg",
    "answer": 12
  },
  {
    "type": "CORPS",
    "q": "Longueur du fémur adulte moyen ?",
    "unit": "En cm",
    "answer": 45
  },
  {
    "type": "CORPS",
    "q": "Nombre de vertèbres ?",
    "unit": "En vertèbres",
    "answer": 33
  },
  {
    "type": "CORPS",
    "q": "Nombre de côtes ?",
    "unit": "En côtes",
    "answer": 24
  },
  {
    "type": "CORPS",
    "q": "Longueur de la moelle épinière ?",
    "unit": "En cm",
    "answer": 45
  },
  {
    "type": "CORPS",
    "q": "Nombre de chromosomes ?",
    "unit": "En chromosomes",
    "answer": 46
  },
  {
    "type": "CORPS",
    "q": "Nombre de gènes chez l'humain ?",
    "unit": "En milliers",
    "answer": 20
  },
  {
    "type": "CORPS",
    "q": "Pourcentage d'ADN commun avec un chimpanzé ?",
    "unit": "En %",
    "answer": 99
  },
  {
    "type": "CORPS",
    "q": "Nombre de litres de salive produits par jour ?",
    "unit": "En litres",
    "answer": 1
  },
  {
    "type": "CORPS",
    "q": "Durée de renouvellement complet de la peau ?",
    "unit": "En jours",
    "answer": 28
  },
  {
    "type": "CORPS",
    "q": "Vitesse d'un éternuement ?",
    "unit": "En km/h",
    "answer": 160
  },
  {
    "type": "CORPS",
    "q": "Vitesse d'un clignement d'oeil ?",
    "unit": "En ms",
    "answer": 100
  },
  {
    "type": "CORPS",
    "q": "Nombre de bactéries dans l'intestin ?",
    "unit": "En billions",
    "answer": 38
  },
  {
    "type": "CORPS",
    "q": "Poids des bactéries intestinales ?",
    "unit": "En kg",
    "answer": 2
  },
  {
    "type": "CORPS",
    "q": "Longueur d'un cheveu qui pousse par mois ?",
    "unit": "En cm",
    "answer": 1
  },
  {
    "type": "CORPS",
    "q": "Nombre d'ongles ?",
    "unit": "En ongles",
    "answer": 20
  },
  {
    "type": "CORPS",
    "q": "Durée de croissance d'un ongle complet ?",
    "unit": "En mois",
    "answer": 6
  },
  {
    "type": "CORPS",
    "q": "Nombre de litres de larmes par an ?",
    "unit": "En ml",
    "answer": 300
  },
  {
    "type": "CORPS",
    "q": "Pourcentage d'eau dans le cerveau ?",
    "unit": "En %",
    "answer": 75
  },
  {
    "type": "CORPS",
    "q": "Consommation du cerveau en % de l'énergie totale ?",
    "unit": "En %",
    "answer": 20
  },
  {
    "type": "CORPS",
    "q": "Nombre de neurones dans le cerveau ?",
    "unit": "En milliards",
    "answer": 86
  },
  {
    "type": "CORPS",
    "q": "Nombre de synapses ?",
    "unit": "En billions",
    "answer": 100
  },
  {
    "type": "CORPS",
    "q": "Vitesse d'un influx nerveux ?",
    "unit": "En km/h",
    "answer": 400
  },
  {
    "type": "CORPS",
    "q": "Poids d'un oeil ?",
    "unit": "En g",
    "answer": 7
  },
  {
    "type": "CORPS",
    "q": "Diamètre de l'oeil ?",
    "unit": "En mm",
    "answer": 24
  },
  {
    "type": "CORPS",
    "q": "Nombre de couleurs distinguées par l'oeil ?",
    "unit": "En millions",
    "answer": 10
  },
  {
    "type": "CORPS",
    "q": "Distance minimale de vision nette (adulte jeune) ?",
    "unit": "En cm",
    "answer": 25
  },
  {
    "type": "CORPS",
    "q": "Nombre de muscles pour sourire ?",
    "unit": "En muscles",
    "answer": 17
  },
  {
    "type": "CORPS",
    "q": "Nombre de muscles pour faire la grimace ?",
    "unit": "En muscles",
    "answer": 43
  },
  {
    "type": "CORPS",
    "q": "Longueur totale de l'ADN dans une cellule ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "CORPS",
    "q": "Longueur totale de l'ADN dans tout le corps ?",
    "unit": "En milliards de km",
    "answer": 1
  },
  {
    "type": "CORPS",
    "q": "Nombre de cellules dans le corps humain ?",
    "unit": "En billions",
    "answer": 30
  },
  {
    "type": "CORPS",
    "q": "Nombre de fois où on respire par jour ?",
    "unit": "En fois",
    "answer": 20000
  },
  {
    "type": "CORPS",
    "q": "Volume courant respiratoire (1 inspiration) ?",
    "unit": "En ml",
    "answer": 500
  },
  {
    "type": "CORPS",
    "q": "Capacité pulmonaire totale ?",
    "unit": "En litres",
    "answer": 6
  },
  {
    "type": "CORPS",
    "q": "Nombre d'alvéoles pulmonaires ?",
    "unit": "En millions",
    "answer": 480
  },
  {
    "type": "CORPS",
    "q": "Surface des alvéoles ?",
    "unit": "En m2",
    "answer": 70
  },
  {
    "type": "CORPS",
    "q": "Fréquence respiratoire au repos par minute ?",
    "unit": "En fois/minute",
    "answer": 16
  },
  {
    "type": "CORPS",
    "q": "Nombre de litres de sang pompés par le coeur par jour ?",
    "unit": "En litres",
    "answer": 7000
  },
  {
    "type": "CORPS",
    "q": "Longueur d'un globule blanc ?",
    "unit": "En micromètres",
    "answer": 15
  },
  {
    "type": "CORPS",
    "q": "Nombre de plaquettes par mm3 ?",
    "unit": "En milliers",
    "answer": 250
  },
  {
    "type": "CORPS",
    "q": "Durée de vie d'une plaquette ?",
    "unit": "En jours",
    "answer": 10
  },
  {
    "type": "CORPS",
    "q": "Nombre de groupes sanguins ABO ?",
    "unit": "En groupes",
    "answer": 4
  },
  {
    "type": "CORPS",
    "q": "Pourcentage de la population O+ en France ?",
    "unit": "En %",
    "answer": 36
  },
  {
    "type": "CORPS",
    "q": "Poids de la peau ?",
    "unit": "En kg",
    "answer": 4
  },
  {
    "type": "CORPS",
    "q": "Épaisseur moyenne de la peau ?",
    "unit": "En mm",
    "answer": 2
  },
  {
    "type": "CORPS",
    "q": "Nombre de glandes sudoripares ?",
    "unit": "En millions",
    "answer": 2
  },
  {
    "type": "CORPS",
    "q": "Quantité de sueur par jour en été ?",
    "unit": "En litres",
    "answer": 1
  },
  {
    "type": "CORPS",
    "q": "Température de la peau ?",
    "unit": "En °C",
    "answer": 33
  },
  {
    "type": "CORPS",
    "q": "Nombre de poils sur le corps ?",
    "unit": "En millions",
    "answer": 5
  },
  {
    "type": "CORPS",
    "q": "Longueur totale des nerfs ?",
    "unit": "En km",
    "answer": 72
  },
  {
    "type": "CORPS",
    "q": "Poids du pancréas ?",
    "unit": "En g",
    "answer": 80
  },
  {
    "type": "CORPS",
    "q": "Poids des reins (les deux) ?",
    "unit": "En g",
    "answer": 300
  },
  {
    "type": "CORPS",
    "q": "Longueur d'un rein ?",
    "unit": "En cm",
    "answer": 11
  },
  {
    "type": "CORPS",
    "q": "Volume de la vessie pleine ?",
    "unit": "En ml",
    "answer": 500
  },
  {
    "type": "CORPS",
    "q": "Nombre de mictions par jour ?",
    "unit": "En fois",
    "answer": 6
  },
  {
    "type": "CORPS",
    "q": "Longueur de l'urètre masculin ?",
    "unit": "En cm",
    "answer": 20
  },
  {
    "type": "CORPS",
    "q": "Longueur de l'urètre féminin ?",
    "unit": "En cm",
    "answer": 4
  },
  {
    "type": "CORPS",
    "q": "Poids de la thyroïde ?",
    "unit": "En g",
    "answer": 20
  },
  {
    "type": "CORPS",
    "q": "Nombre d'hormones principales ?",
    "unit": "En hormones",
    "answer": 50
  },
  {
    "type": "CORPS",
    "q": "Taux de sucre normal à jeun ?",
    "unit": "En g/L",
    "answer": 1
  },
  {
    "type": "CORPS",
    "q": "Cholestérol total limite haute ?",
    "unit": "En g/L",
    "answer": 2
  },
  {
    "type": "CORPS",
    "q": "Nombre de litres de lymphe ?",
    "unit": "En litres",
    "answer": 2
  },
  {
    "type": "CORPS",
    "q": "Nombre de ganglions lymphatiques ?",
    "unit": "En ganglions",
    "answer": 600
  },
  {
    "type": "CORPS",
    "q": "Durée de vie d'un cheveu ?",
    "unit": "En années",
    "answer": 5
  },
  {
    "type": "CORPS",
    "q": "Nombre de cils par oeil ?",
    "unit": "En cils",
    "answer": 150
  },
  {
    "type": "CORPS",
    "q": "Durée de vie d'un cil ?",
    "unit": "En jours",
    "answer": 150
  },
  {
    "type": "CORPS",
    "q": "Nombre de sourcils (poils) ?",
    "unit": "En poils",
    "answer": 500
  },
  {
    "type": "CORPS",
    "q": "Longueur d'un cil ?",
    "unit": "En mm",
    "answer": 10
  },
  {
    "type": "CORPS",
    "q": "Poids d'un poumon ?",
    "unit": "En g",
    "answer": 500
  },
  {
    "type": "CORPS",
    "q": "Nombre de lobes du poumon droit ?",
    "unit": "En lobes",
    "answer": 3
  },
  {
    "type": "CORPS",
    "q": "Nombre de lobes du poumon gauche ?",
    "unit": "En lobes",
    "answer": 2
  },
  {
    "type": "CORPS",
    "q": "Longueur de la trachée ?",
    "unit": "En cm",
    "answer": 12
  },
  {
    "type": "CORPS",
    "q": "Diamètre de la trachée ?",
    "unit": "En mm",
    "answer": 20
  },
  {
    "type": "CORPS",
    "q": "Nombre de dents de lait ?",
    "unit": "En dents",
    "answer": 20
  },
  {
    "type": "CORPS",
    "q": "Âge moyen de poussée des premières dents ?",
    "unit": "En mois",
    "answer": 6
  },
  {
    "type": "CORPS",
    "q": "Âge des dents de sagesse ?",
    "unit": "En années",
    "answer": 18
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un éléphant d'Afrique mâle adulte ?",
    "unit": "En kg",
    "answer": 6000
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'une baleine bleue adulte ?",
    "unit": "En kg",
    "answer": 130000
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un ours polaire mâle ?",
    "unit": "En kg",
    "answer": 500
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un lion mâle adulte ?",
    "unit": "En kg",
    "answer": 190
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un tigre du Bengale mâle ?",
    "unit": "En kg",
    "answer": 220
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un gorille dos argenté ?",
    "unit": "En kg",
    "answer": 180
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un hippopotame ?",
    "unit": "En kg",
    "answer": 1500
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'une girafe mâle ?",
    "unit": "En kg",
    "answer": 1200
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un rhinocéros blanc ?",
    "unit": "En kg",
    "answer": 2300
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un zèbre ?",
    "unit": "En kg",
    "answer": 300
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse de pointe d'un guépard ?",
    "unit": "En km/h",
    "answer": 110
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse d'un lion à la course ?",
    "unit": "En km/h",
    "answer": 80
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse d'un éléphant à la course ?",
    "unit": "En km/h",
    "answer": 40
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'une tortue géante ?",
    "unit": "En années",
    "answer": 150
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un éléphant ?",
    "unit": "En années",
    "answer": 70
  },
  {
    "type": "ANIMAL",
    "q": "Nombre d'oeufs pondus par une tortue marine ?",
    "unit": "En oeufs",
    "answer": 100
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un oeuf d'autruche ?",
    "unit": "En g",
    "answer": 1500
  },
  {
    "type": "ANIMAL",
    "q": "Envergure d'un albatros hurleur ?",
    "unit": "En m",
    "answer": 3
  },
  {
    "type": "ANIMAL",
    "q": "Profondeur de plongée d'un cachalot ?",
    "unit": "En m",
    "answer": 2250
  },
  {
    "type": "ANIMAL",
    "q": "Nombre de dents d'un requin blanc ?",
    "unit": "En dents",
    "answer": 300
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un phoque commun adulte ?",
    "unit": "En kg",
    "answer": 100
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un morse adulte femelle ?",
    "unit": "En kg",
    "answer": 800
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'une hyène tachetée adulte ?",
    "unit": "En kg",
    "answer": 55
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un chacal doré adulte ?",
    "unit": "En kg",
    "answer": 10
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un lynx boréal adulte ?",
    "unit": "En kg",
    "answer": 20
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un ocelot adulte ?",
    "unit": "En kg",
    "answer": 10
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'une panthère des neiges adulte ?",
    "unit": "En kg",
    "answer": 40
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un wombat adulte ?",
    "unit": "En kg",
    "answer": 25
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un paresseux à trois doigts adulte ?",
    "unit": "En kg",
    "answer": 4
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un tatou géant adulte ?",
    "unit": "En kg",
    "answer": 30
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un fourmilier géant adulte ?",
    "unit": "En kg",
    "answer": 35
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un ratel (blaireau à miel) adulte ?",
    "unit": "En kg",
    "answer": 10
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un capybara adulte ?",
    "unit": "En kg",
    "answer": 50
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un lamantin adulte ?",
    "unit": "En kg",
    "answer": 500
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un phacochère adulte ?",
    "unit": "En kg",
    "answer": 80
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un tapir adulte ?",
    "unit": "En kg",
    "answer": 250
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un okapi adulte ?",
    "unit": "En kg",
    "answer": 250
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un buffle d'Afrique adulte ?",
    "unit": "En kg",
    "answer": 700
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un gnou adulte ?",
    "unit": "En kg",
    "answer": 200
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un phoque léopard adulte ?",
    "unit": "En kg",
    "answer": 400
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un ours brun européen adulte ?",
    "unit": "En kg",
    "answer": 200
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'une hermine adulte ?",
    "unit": "En g",
    "answer": 250
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse de pointe d'un axolotl ?",
    "unit": "En km/h",
    "answer": 2
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse de pointe d'un rhinocéros ?",
    "unit": "En km/h",
    "answer": 50
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un zèbre en captivité ?",
    "unit": "En années",
    "answer": 30
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un kangourou roux adulte mâle ?",
    "unit": "En kg",
    "answer": 85
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un kangourou roux adulte ?",
    "unit": "En cm",
    "answer": 230
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un perroquet adulte ?",
    "unit": "En cm",
    "answer": 34
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un grenouille adulte ?",
    "unit": "En cm",
    "answer": 8
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse de pointe d'un salamandre ?",
    "unit": "En km/h",
    "answer": 1
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse de pointe d'un alligator ?",
    "unit": "En km/h",
    "answer": 30
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un sanglier adulte ?",
    "unit": "En cm",
    "answer": 150
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un albatros en captivité ?",
    "unit": "En années",
    "answer": 73
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un jaguar adulte ?",
    "unit": "En kg",
    "answer": 90
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un axolotl adulte ?",
    "unit": "En cm",
    "answer": 25
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse de pointe d'un lama ?",
    "unit": "En km/h",
    "answer": 60
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un sanglier adulte mâle ?",
    "unit": "En kg",
    "answer": 100
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un girafe adulte mâle ?",
    "unit": "En kg",
    "answer": 1900
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un flamant rose adulte ?",
    "unit": "En cm",
    "answer": 140
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un gorille en captivité ?",
    "unit": "En années",
    "answer": 40
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un aigle royal adulte ?",
    "unit": "En cm",
    "answer": 80
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un dromadaire adulte mâle ?",
    "unit": "En kg",
    "answer": 500
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un toucan en captivité ?",
    "unit": "En années",
    "answer": 20
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un cigogne adulte ?",
    "unit": "En cm",
    "answer": 110
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un chien adulte ?",
    "unit": "En cm",
    "answer": 50
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un zébu en captivité ?",
    "unit": "En années",
    "answer": 26
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un yack adulte ?",
    "unit": "En cm",
    "answer": 160
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un koala adulte ?",
    "unit": "En cm",
    "answer": 70
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un dromadaire en captivité ?",
    "unit": "En années",
    "answer": 40
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse de pointe d'un manchot empereur ?",
    "unit": "En km/h",
    "answer": 9
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un puma en captivité ?",
    "unit": "En années",
    "answer": 23
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un guépard adulte mâle ?",
    "unit": "En kg",
    "answer": 55
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un sanglier adulte ?",
    "unit": "En kg",
    "answer": 80
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un tortue adulte ?",
    "unit": "En cm",
    "answer": 30
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un python en captivité ?",
    "unit": "En années",
    "answer": 25
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un lézard en captivité ?",
    "unit": "En années",
    "answer": 27
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un anaconda en captivité ?",
    "unit": "En années",
    "answer": 22
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un loup adulte mâle ?",
    "unit": "En kg",
    "answer": 45
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse de pointe d'un faucon pèlerin ?",
    "unit": "En km/h",
    "answer": 300
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un faisan adulte ?",
    "unit": "En cm",
    "answer": 75
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un chat en captivité ?",
    "unit": "En années",
    "answer": 15
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un gorille adulte mâle ?",
    "unit": "En kg",
    "answer": 170
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un sanglier en captivité ?",
    "unit": "En années",
    "answer": 12
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un hibou adulte ?",
    "unit": "En cm",
    "answer": 60
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un scarabée adulte ?",
    "unit": "En cm",
    "answer": 5
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un paon adulte ?",
    "unit": "En cm",
    "answer": 181
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un puma adulte ?",
    "unit": "En kg",
    "answer": 70
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un rhinocéros en captivité ?",
    "unit": "En années",
    "answer": 45
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un perdrix en captivité ?",
    "unit": "En années",
    "answer": 10
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un perdrix adulte ?",
    "unit": "En cm",
    "answer": 30
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un alligator en captivité ?",
    "unit": "En années",
    "answer": 50
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un yack adulte ?",
    "unit": "En kg",
    "answer": 400
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un caméléon adulte ?",
    "unit": "En cm",
    "answer": 30
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse de pointe d'un scarabée ?",
    "unit": "En km/h",
    "answer": 5
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'un caille en captivité ?",
    "unit": "En années",
    "answer": 5
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un renard adulte ?",
    "unit": "En cm",
    "answer": 60
  },
  {
    "type": "ANIMAL",
    "q": "Taille d'un salamandre adulte ?",
    "unit": "En cm",
    "answer": 20
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse de pointe d'un éléphant ?",
    "unit": "En km/h",
    "answer": 25
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un aigle royal adulte ?",
    "unit": "En kg",
    "answer": 5
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un koala adulte mâle ?",
    "unit": "En kg",
    "answer": 12
  },
  {
    "type": "CULTURE",
    "q": "Durée du film Titanic version cinéma ?",
    "unit": "En minutes",
    "answer": 195
  },
  {
    "type": "CULTURE",
    "q": "Durée du film Avatar 1 ?",
    "unit": "En minutes",
    "answer": 162
  },
  {
    "type": "CULTURE",
    "q": "Durée du film Avengers Endgame ?",
    "unit": "En minutes",
    "answer": 181
  },
  {
    "type": "CULTURE",
    "q": "Durée du film Le Seigneur des Anneaux La Communauté version longue ?",
    "unit": "En minutes",
    "answer": 228
  },
  {
    "type": "CULTURE",
    "q": "Durée du film Interstellar ?",
    "unit": "En minutes",
    "answer": 169
  },
  {
    "type": "CULTURE",
    "q": "Durée du film Inception ?",
    "unit": "En minutes",
    "answer": 148
  },
  {
    "type": "CULTURE",
    "q": "Durée du film Gladiator ?",
    "unit": "En minutes",
    "answer": 155
  },
  {
    "type": "CULTURE",
    "q": "Durée du film Matrix ?",
    "unit": "En minutes",
    "answer": 136
  },
  {
    "type": "CULTURE",
    "q": "Durée du film Star Wars Un Nouvel Espoir ?",
    "unit": "En minutes",
    "answer": 121
  },
  {
    "type": "CULTURE",
    "q": "Durée du film Harry Potter à l'école des sorciers ?",
    "unit": "En minutes",
    "answer": 152
  },
  {
    "type": "CULTURE",
    "q": "Nombre de pages de Harry Potter 1 édition française ?",
    "unit": "En pages",
    "answer": 305
  },
  {
    "type": "CULTURE",
    "q": "Nombre de pages du Petit Prince ?",
    "unit": "En pages",
    "answer": 96
  },
  {
    "type": "CULTURE",
    "q": "Nombre de chapitres de la Bible ?",
    "unit": "En chapitres",
    "answer": 1189
  },
  {
    "type": "CULTURE",
    "q": "Nombre de tomes de One Piece en 2024 ?",
    "unit": "En tomes",
    "answer": 108
  },
  {
    "type": "CULTURE",
    "q": "Nombre d'épisodes de Naruto Shippuden ?",
    "unit": "En épisodes",
    "answer": 500
  },
  {
    "type": "CULTURE",
    "q": "Nombre d'épisodes de Dragon Ball Z ?",
    "unit": "En épisodes",
    "answer": 291
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie du premier iPhone ?",
    "unit": "En année",
    "answer": 2007
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie de Facebook ?",
    "unit": "En année",
    "answer": 2004
  },
  {
    "type": "CULTURE",
    "q": "Année de création de Google ?",
    "unit": "En année",
    "answer": 1998
  },
  {
    "type": "CULTURE",
    "q": "Nombre de saisons de Game of Thrones ?",
    "unit": "En saisons",
    "answer": 8
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie du jeu vidéo Pac-Man ?",
    "unit": "En année",
    "answer": 1980
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie de la PlayStation 1 ?",
    "unit": "En année",
    "answer": 1994
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie de la première Xbox ?",
    "unit": "En année",
    "answer": 2001
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie de Minecraft ?",
    "unit": "En année",
    "answer": 2011
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie de Fortnite ?",
    "unit": "En année",
    "answer": 2017
  },
  {
    "type": "CULTURE",
    "q": "Année de création de Wikipedia ?",
    "unit": "En année",
    "answer": 2001
  },
  {
    "type": "CULTURE",
    "q": "Année de création de YouTube ?",
    "unit": "En année",
    "answer": 2005
  },
  {
    "type": "CULTURE",
    "q": "Année de création d'Instagram ?",
    "unit": "En année",
    "answer": 2010
  },
  {
    "type": "CULTURE",
    "q": "Année de création de TikTok ?",
    "unit": "En année",
    "answer": 2016
  },
  {
    "type": "CULTURE",
    "q": "Année de création de Twitter (X) ?",
    "unit": "En année",
    "answer": 2006
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie du premier Star Wars ?",
    "unit": "En année",
    "answer": 1977
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie du premier film Harry Potter ?",
    "unit": "En année",
    "answer": 2001
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie du premier film Le Seigneur des Anneaux ?",
    "unit": "En année",
    "answer": 2001
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie de Titanic (film) ?",
    "unit": "En année",
    "answer": 1997
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie d'Avatar (1er film) ?",
    "unit": "En année",
    "answer": 2009
  },
  {
    "type": "CULTURE",
    "q": "Année de première diffusion des Simpson ?",
    "unit": "En année",
    "answer": 1989
  },
  {
    "type": "CULTURE",
    "q": "Nombre de saisons des Simpson à ce jour ?",
    "unit": "En saisons",
    "answer": 35
  },
  {
    "type": "CULTURE",
    "q": "Nombre de saisons de Friends ?",
    "unit": "En saisons",
    "answer": 10
  },
  {
    "type": "CULTURE",
    "q": "Nombre d'épisodes de Friends ?",
    "unit": "En épisodes",
    "answer": 236
  },
  {
    "type": "CULTURE",
    "q": "Nombre de saisons de Breaking Bad ?",
    "unit": "En saisons",
    "answer": 5
  },
  {
    "type": "CULTURE",
    "q": "Nombre de saisons de Stranger Things ?",
    "unit": "En saisons",
    "answer": 4
  },
  {
    "type": "CULTURE",
    "q": "Nombre de films dans le MCU (Marvel, 2024) ?",
    "unit": "En films",
    "answer": 33
  },
  {
    "type": "CULTURE",
    "q": "Nombre de films Star Wars (saga principale) ?",
    "unit": "En films",
    "answer": 9
  },
  {
    "type": "CULTURE",
    "q": "Nombre de livres de la saga Harry Potter ?",
    "unit": "En livres",
    "answer": 7
  },
  {
    "type": "CULTURE",
    "q": "Nombre de tomes du Seigneur des Anneaux ?",
    "unit": "En tomes",
    "answer": 3
  },
  {
    "type": "CULTURE",
    "q": "Nombre d'albums studio des Beatles ?",
    "unit": "En albums",
    "answer": 12
  },
  {
    "type": "CULTURE",
    "q": "Nombre de morceaux sur l'album Thriller de Michael Jackson ?",
    "unit": "En morceaux",
    "answer": 9
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie de l'album Thriller ?",
    "unit": "En année",
    "answer": 1982
  },
  {
    "type": "CULTURE",
    "q": "Nombre de Grammy Awards remportés par Beyoncé à ce jour ?",
    "unit": "En Grammys",
    "answer": 32
  },
  {
    "type": "CULTURE",
    "q": "Année de la première Coupe du Monde de football ?",
    "unit": "En année",
    "answer": 1930
  },
  {
    "type": "CULTURE",
    "q": "Nombre de Coupes du Monde gagnées par le Brésil ?",
    "unit": "En coupes",
    "answer": 5
  },
  {
    "type": "CULTURE",
    "q": "Nombre de Coupes du Monde gagnées par la France ?",
    "unit": "En coupes",
    "answer": 2
  },
  {
    "type": "CULTURE",
    "q": "Année du premier titre de Champion du Monde de la France ?",
    "unit": "En année",
    "answer": 1998
  },
  {
    "type": "CULTURE",
    "q": "Nombre de Ballons d'Or remportés par Messi à ce jour ?",
    "unit": "En Ballons d'Or",
    "answer": 8
  },
  {
    "type": "CULTURE",
    "q": "Nombre de médailles d'or de la France aux JO de Paris 2024 ?",
    "unit": "En médailles",
    "answer": 16
  },
  {
    "type": "CULTURE",
    "q": "Nombre total de médailles de la France aux JO de Paris 2024 ?",
    "unit": "En médailles",
    "answer": 64
  },
  {
    "type": "CULTURE",
    "q": "Nombre de sports aux JO d'été de Paris 2024 ?",
    "unit": "En sports",
    "answer": 32
  },
  {
    "type": "CULTURE",
    "q": "Année des premiers Jeux Olympiques modernes ?",
    "unit": "En année",
    "answer": 1896
  },
  {
    "type": "CULTURE",
    "q": "Nombre de tomes de Naruto (total) ?",
    "unit": "En tomes",
    "answer": 72
  },
  {
    "type": "CULTURE",
    "q": "Nombre de tomes de Dragon Ball (total) ?",
    "unit": "En tomes",
    "answer": 42
  },
  {
    "type": "CULTURE",
    "q": "Nombre de tomes d'Astérix parus à ce jour ?",
    "unit": "En tomes",
    "answer": 40
  },
  {
    "type": "CULTURE",
    "q": "Nombre de tomes de Tintin ?",
    "unit": "En tomes",
    "answer": 24
  },
  {
    "type": "CULTURE",
    "q": "Année de création d'Astérix (BD) ?",
    "unit": "En année",
    "answer": 1959
  },
  {
    "type": "CULTURE",
    "q": "Année de création de Tintin (BD) ?",
    "unit": "En année",
    "answer": 1929
  },
  {
    "type": "CULTURE",
    "q": "Nombre de romans de la saga Twilight ?",
    "unit": "En romans",
    "answer": 4
  },
  {
    "type": "CULTURE",
    "q": "Nombre de films de la saga Twilight ?",
    "unit": "En films",
    "answer": 5
  },
  {
    "type": "CULTURE",
    "q": "Nombre de romans de la trilogie Hunger Games (originale) ?",
    "unit": "En romans",
    "answer": 3
  },
  {
    "type": "CULTURE",
    "q": "Nombre de saisons de Peaky Blinders ?",
    "unit": "En saisons",
    "answer": 6
  },
  {
    "type": "CULTURE",
    "q": "Nombre de saisons de The Walking Dead ?",
    "unit": "En saisons",
    "answer": 11
  },
  {
    "type": "CULTURE",
    "q": "Nombre d'épisodes de Game of Thrones (total) ?",
    "unit": "En épisodes",
    "answer": 73
  },
  {
    "type": "CULTURE",
    "q": "Année de fin de la série Game of Thrones ?",
    "unit": "En année",
    "answer": 2019
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie de la chanson Blinding Lights (The Weeknd) ?",
    "unit": "En année",
    "answer": 2019
  },
  {
    "type": "CULTURE",
    "q": "Nombre de semaines n°1 de Old Town Road au Billboard ?",
    "unit": "En semaines",
    "answer": 19
  },
  {
    "type": "CULTURE",
    "q": "Nombre d'Oscars remportés par le film Titanic ?",
    "unit": "En Oscars",
    "answer": 11
  },
  {
    "type": "CULTURE",
    "q": "Nombre d'Oscars remportés par Le Seigneur des Anneaux - Le Retour du Roi ?",
    "unit": "En Oscars",
    "answer": 11
  },
  {
    "type": "CULTURE",
    "q": "Nombre de nominations aux Oscars pour La La Land ?",
    "unit": "En nominations",
    "answer": 14
  },
  {
    "type": "CULTURE",
    "q": "Année de la première cérémonie des Oscars ?",
    "unit": "En année",
    "answer": 1929
  },
  {
    "type": "CULTURE",
    "q": "Nombre de morceaux sur l'album Random Access Memories de Daft Punk ?",
    "unit": "En morceaux",
    "answer": 13
  },
  {
    "type": "CULTURE",
    "q": "Année de séparation de Daft Punk ?",
    "unit": "En année",
    "answer": 2021
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie du premier album de Daft Punk ?",
    "unit": "En année",
    "answer": 1997
  },
  {
    "type": "CULTURE",
    "q": "Année de création de Lucky Luke (BD) ?",
    "unit": "En année",
    "answer": 1946
  },
  {
    "type": "CULTURE",
    "q": "Nombre de tomes de L'Attaque des Titans ?",
    "unit": "En tomes",
    "answer": 34
  },
  {
    "type": "CULTURE",
    "q": "Nombre de saisons de La Casa de Papel (Money Heist) ?",
    "unit": "En saisons",
    "answer": 5
  },
  {
    "type": "CULTURE",
    "q": "Nombre de morceaux dans l'album 1989 de Taylor Swift ?",
    "unit": "En morceaux",
    "answer": 13
  },
  {
    "type": "CULTURE",
    "q": "Nombre de Grammy Awards de Taylor Swift à ce jour ?",
    "unit": "En Grammys",
    "answer": 14
  },
  {
    "type": "CULTURE",
    "q": "Nombre d'épisodes de la saison 1 de Squid Game ?",
    "unit": "En épisodes",
    "answer": 9
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie de Squid Game ?",
    "unit": "En année",
    "answer": 2021
  },
  {
    "type": "CULTURE",
    "q": "Nombre de langues dans lesquelles Le Petit Prince a été traduit ?",
    "unit": "En langues",
    "answer": 300
  },
  {
    "type": "CULTURE",
    "q": "Nombre d'exemplaires vendus du Petit Prince dans le monde (en millions) ?",
    "unit": "En millions",
    "answer": 200
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie du premier iPod ?",
    "unit": "En année",
    "answer": 2001
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie de la première PlayStation portable (PSP) ?",
    "unit": "En année",
    "answer": 2004
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie de la Nintendo DS ?",
    "unit": "En année",
    "answer": 2004
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie de World of Warcraft ?",
    "unit": "En année",
    "answer": 2004
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie de GTA V ?",
    "unit": "En année",
    "answer": 2013
  },
  {
    "type": "CULTURE",
    "q": "Nombre de jeux de la saga Zelda parus à ce jour ?",
    "unit": "En jeux",
    "answer": 20
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie du premier Super Mario Bros ?",
    "unit": "En année",
    "answer": 1985
  },
  {
    "type": "CULTURE",
    "q": "Année de création de Netflix ?",
    "unit": "En année",
    "answer": 1997
  },
  {
    "type": "CULTURE",
    "q": "Année où Netflix a lancé le streaming ?",
    "unit": "En année",
    "answer": 2007
  },
  {
    "type": "CULTURE",
    "q": "Nombre de saisons de la série Lupin (avec Omar Sy) ?",
    "unit": "En saisons",
    "answer": 3
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie du film Le Fabuleux Destin d'Amélie Poulain ?",
    "unit": "En année",
    "answer": 2001
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de fois où on cligne des yeux par jour ?",
    "unit": "En fois",
    "answer": 15000
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de fois où on respire par jour ?",
    "unit": "En fois",
    "answer": 20000
  },
  {
    "type": "ABSURDE",
    "q": "Longueur totale des vaisseaux sanguins si mis bout à bout ?",
    "unit": "En km",
    "answer": 100000
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage cumulus moyen ?",
    "unit": "En tonnes",
    "answer": 500
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de grains de sable sur Terre (estimation) ?",
    "unit": "En sextillions",
    "answer": 7
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de fourmis sur Terre ?",
    "unit": "En quadrillions",
    "answer": 20
  },
  {
    "type": "ABSURDE",
    "q": "Masse de toutes les fourmis vs masse de tous les humains ?",
    "unit": "En fois",
    "answer": 1
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de feuilles sur un chêne adulte ?",
    "unit": "En milliers",
    "answer": 250
  },
  {
    "type": "ABSURDE",
    "q": "Hauteur du plus grand arbre (séquoia Hyperion) ?",
    "unit": "En m",
    "answer": 115
  },
  {
    "type": "ABSURDE",
    "q": "Âge du plus vieil arbre (pin Mathusalem) ?",
    "unit": "En années",
    "answer": 4850
  },
  {
    "type": "ABSURDE",
    "q": "Vitesse de croissance du bambou record par jour ?",
    "unit": "En cm",
    "answer": 91
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de battements de coeur d'une baleine bleue par minute ?",
    "unit": "En battements",
    "answer": 6
  },
  {
    "type": "ABSURDE",
    "q": "Pression artérielle d'une girafe ?",
    "unit": "En mmHg",
    "answer": 280
  },
  {
    "type": "ABSURDE",
    "q": "Nombre d'oeufs pondus par une poule par an ?",
    "unit": "En oeufs",
    "answer": 300
  },
  {
    "type": "ABSURDE",
    "q": "Durée de vie d'une poule pondeuse ?",
    "unit": "En années",
    "answer": 8
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de dents d'un escargot ?",
    "unit": "En dents",
    "answer": 14000
  },
  {
    "type": "ABSURDE",
    "q": "Vitesse d'un escargot ?",
    "unit": "En m/h",
    "answer": 50
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de coeurs d'une pieuvre ?",
    "unit": "En coeurs",
    "answer": 3
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de cerveaux d'une pieuvre ?",
    "unit": "En cerveaux",
    "answer": 9
  },
  {
    "type": "ABSURDE",
    "q": "Couleur du sang d'une pieuvre ?",
    "unit": "En couleur (bleu=1)",
    "answer": 1
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de cheveux sur un humain ?",
    "unit": "En nombre",
    "answer": 70801
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de cils sur un humain ?",
    "unit": "En nombre",
    "answer": 69679
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de ongles sur un humain ?",
    "unit": "En nombre",
    "answer": 9969
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de poils sur un humain ?",
    "unit": "En nombre",
    "answer": 59709
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Bordeaux ?",
    "unit": "En tonnes",
    "answer": 571
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Brest ?",
    "unit": "En tonnes",
    "answer": 735
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Toulouse ?",
    "unit": "En tonnes",
    "answer": 705
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Lille ?",
    "unit": "En tonnes",
    "answer": 529
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Angers ?",
    "unit": "En tonnes",
    "answer": 755
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Nice ?",
    "unit": "En tonnes",
    "answer": 688
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Metz ?",
    "unit": "En tonnes",
    "answer": 356
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Lyon ?",
    "unit": "En tonnes",
    "answer": 759
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Montpellier ?",
    "unit": "En tonnes",
    "answer": 322
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Nantes ?",
    "unit": "En tonnes",
    "answer": 371
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Paris ?",
    "unit": "En tonnes",
    "answer": 941
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Rennes ?",
    "unit": "En tonnes",
    "answer": 728
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Amiens ?",
    "unit": "En tonnes",
    "answer": 690
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Dijon ?",
    "unit": "En tonnes",
    "answer": 323
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Marseille ?",
    "unit": "En tonnes",
    "answer": 601
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Tours ?",
    "unit": "En tonnes",
    "answer": 776
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Grenoble ?",
    "unit": "En tonnes",
    "answer": 915
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Reims ?",
    "unit": "En tonnes",
    "answer": 616
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Strasbourg ?",
    "unit": "En tonnes",
    "answer": 488
  },
  {
    "type": "ABSURDE",
    "q": "Poids d'un nuage d'orage moyen à Nîmes ?",
    "unit": "En tonnes",
    "answer": 636
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de mots prononcés en moyenne par un Français par jour ?",
    "unit": "En mots",
    "answer": 16000
  },
  {
    "type": "ABSURDE",
    "q": "Nombre d'étoiles visibles à l'oeil nu par nuit claire ?",
    "unit": "En étoiles",
    "answer": 2500
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de battements de coeur dans une vie humaine ?",
    "unit": "En milliards",
    "answer": 3
  },
  {
    "type": "ABSURDE",
    "q": "Distance parcourue par le sang dans le corps en une journée ?",
    "unit": "En km",
    "answer": 19000
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de respirations dans une vie humaine ?",
    "unit": "En millions",
    "answer": 600
  },
  {
    "type": "ABSURDE",
    "q": "Quantité de poussière qui se dépose dans une maison par an ?",
    "unit": "En kg",
    "answer": 18
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de bulles dans une coupe de champagne ?",
    "unit": "En bulles",
    "answer": 2000000
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pas effectués dans une vie humaine ?",
    "unit": "En millions",
    "answer": 200
  },
  {
    "type": "ABSURDE",
    "q": "Vitesse de pousse moyenne d'un ongle par mois ?",
    "unit": "En mm",
    "answer": 3
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de litres d'air respirés par jour ?",
    "unit": "En litres",
    "answer": 11000
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de neurones dans le cerveau humain ?",
    "unit": "En milliards",
    "answer": 86
  },
  {
    "type": "ABSURDE",
    "q": "Quantité de peau perdue par un humain en une vie ?",
    "unit": "En kg",
    "answer": 18
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de nerfs dans le corps humain ?",
    "unit": "En km",
    "answer": 75
  },
  {
    "type": "ABSURDE",
    "q": "Temps total passé à cligner des yeux sur une vie ?",
    "unit": "En jours",
    "answer": 150
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de cellules qui composent le corps humain ?",
    "unit": "En milliers de milliards",
    "answer": 37
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres parcourus par les yeux en lisant un roman ?",
    "unit": "En m",
    "answer": 500
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Paris ?",
    "unit": "En milliers",
    "answer": 15
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Lyon ?",
    "unit": "En milliers",
    "answer": 62
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Marseille ?",
    "unit": "En milliers",
    "answer": 45
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Toulouse ?",
    "unit": "En milliers",
    "answer": 53
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Nice ?",
    "unit": "En milliers",
    "answer": 33
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Nantes ?",
    "unit": "En milliers",
    "answer": 57
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Strasbourg ?",
    "unit": "En milliers",
    "answer": 49
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Montpellier ?",
    "unit": "En milliers",
    "answer": 77
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Bordeaux ?",
    "unit": "En milliers",
    "answer": 22
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Lille ?",
    "unit": "En milliers",
    "answer": 10
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Rennes ?",
    "unit": "En milliers",
    "answer": 33
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Reims ?",
    "unit": "En milliers",
    "answer": 64
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Grenoble ?",
    "unit": "En milliers",
    "answer": 34
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Dijon ?",
    "unit": "En milliers",
    "answer": 70
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Angers ?",
    "unit": "En milliers",
    "answer": 40
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Nîmes ?",
    "unit": "En milliers",
    "answer": 13
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Tours ?",
    "unit": "En milliers",
    "answer": 9
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Amiens ?",
    "unit": "En milliers",
    "answer": 36
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Metz ?",
    "unit": "En milliers",
    "answer": 7
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de pigeons à Brest ?",
    "unit": "En milliers",
    "answer": 19
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Paris ?",
    "unit": "En km",
    "answer": 2329
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Lyon ?",
    "unit": "En km",
    "answer": 959
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Marseille ?",
    "unit": "En km",
    "answer": 358
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Toulouse ?",
    "unit": "En km",
    "answer": 2012
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Nice ?",
    "unit": "En km",
    "answer": 318
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Nantes ?",
    "unit": "En km",
    "answer": 1853
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Strasbourg ?",
    "unit": "En km",
    "answer": 347
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Montpellier ?",
    "unit": "En km",
    "answer": 1420
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Bordeaux ?",
    "unit": "En km",
    "answer": 2608
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Lille ?",
    "unit": "En km",
    "answer": 1418
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Rennes ?",
    "unit": "En km",
    "answer": 2289
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Reims ?",
    "unit": "En km",
    "answer": 2777
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Grenoble ?",
    "unit": "En km",
    "answer": 1956
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Dijon ?",
    "unit": "En km",
    "answer": 391
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Angers ?",
    "unit": "En km",
    "answer": 644
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Nîmes ?",
    "unit": "En km",
    "answer": 607
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Tours ?",
    "unit": "En km",
    "answer": 1644
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Amiens ?",
    "unit": "En km",
    "answer": 202
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Metz ?",
    "unit": "En km",
    "answer": 1999
  },
  {
    "type": "ABSURDE",
    "q": "Nombre de kilomètres de trottoir à Brest ?",
    "unit": "En km",
    "answer": 543
  },
  {
    "type": "WTF",
    "q": "Nombre de fois où on cligne des yeux par jour ?",
    "unit": "En fois",
    "answer": 15000
  },
  {
    "type": "WTF",
    "q": "Nombre de fois où on respire par jour ?",
    "unit": "En fois",
    "answer": 20000
  },
  {
    "type": "WTF",
    "q": "Longueur totale des vaisseaux sanguins si mis bout à bout ?",
    "unit": "En km",
    "answer": 100000
  },
  {
    "type": "WTF",
    "q": "Poids d'un nuage cumulus moyen ?",
    "unit": "En tonnes",
    "answer": 500
  },
  {
    "type": "WTF",
    "q": "Nombre de grains de sable sur Terre (estimation) ?",
    "unit": "En sextillions",
    "answer": 7
  },
  {
    "type": "WTF",
    "q": "Nombre de fourmis sur Terre ?",
    "unit": "En quadrillions",
    "answer": 20
  },
  {
    "type": "WTF",
    "q": "Masse de toutes les fourmis vs masse de tous les humains ?",
    "unit": "En fois",
    "answer": 1
  },
  {
    "type": "WTF",
    "q": "Nombre de feuilles sur un chêne adulte ?",
    "unit": "En milliers",
    "answer": 250
  },
  {
    "type": "WTF",
    "q": "Hauteur du plus grand arbre (séquoia Hyperion) ?",
    "unit": "En m",
    "answer": 115
  },
  {
    "type": "WTF",
    "q": "Âge du plus vieil arbre (pin Mathusalem) ?",
    "unit": "En années",
    "answer": 4850
  },
  {
    "type": "WTF",
    "q": "Vitesse de croissance du bambou record par jour ?",
    "unit": "En cm",
    "answer": 91
  },
  {
    "type": "WTF",
    "q": "Nombre de battements de coeur d'une baleine bleue par minute ?",
    "unit": "En battements",
    "answer": 6
  },
  {
    "type": "WTF",
    "q": "Pression artérielle d'une girafe ?",
    "unit": "En mmHg",
    "answer": 280
  },
  {
    "type": "WTF",
    "q": "Nombre d'oeufs pondus par une poule par an ?",
    "unit": "En oeufs",
    "answer": 300
  },
  {
    "type": "WTF",
    "q": "Durée de vie d'une poule pondeuse ?",
    "unit": "En années",
    "answer": 8
  },
  {
    "type": "WTF",
    "q": "Nombre de dents d'un escargot ?",
    "unit": "En dents",
    "answer": 14000
  },
  {
    "type": "WTF",
    "q": "Vitesse d'un escargot ?",
    "unit": "En m/h",
    "answer": 50
  },
  {
    "type": "WTF",
    "q": "Nombre de coeurs d'une pieuvre ?",
    "unit": "En coeurs",
    "answer": 3
  },
  {
    "type": "WTF",
    "q": "Nombre de cerveaux d'une pieuvre ?",
    "unit": "En cerveaux",
    "answer": 9
  },
  {
    "type": "WTF",
    "q": "Couleur du sang d'une pieuvre ?",
    "unit": "En couleur (bleu=1)",
    "answer": 1
  },
  {
    "type": "WTF",
    "q": "Nombre de cils sur un humain ?",
    "unit": "En nombre",
    "answer": 50025
  },
  {
    "type": "WTF",
    "q": "Nombre de ongles sur un humain ?",
    "unit": "En nombre",
    "answer": 13099
  },
  {
    "type": "WTF",
    "q": "Nombre de poils sur un humain ?",
    "unit": "En nombre",
    "answer": 85914
  },
  {
    "type": "WTF",
    "q": "Nombre de cheveux sur un humain ?",
    "unit": "En nombre",
    "answer": 56470
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Lyon ?",
    "unit": "En cm",
    "answer": 17
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Brest ?",
    "unit": "En cm",
    "answer": 26
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Montpellier ?",
    "unit": "En cm",
    "answer": 10
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Paris ?",
    "unit": "En cm",
    "answer": 28
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Nîmes ?",
    "unit": "En cm",
    "answer": 26
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Metz ?",
    "unit": "En cm",
    "answer": 30
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Tours ?",
    "unit": "En cm",
    "answer": 25
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Nice ?",
    "unit": "En cm",
    "answer": 24
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Reims ?",
    "unit": "En cm",
    "answer": 28
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Nantes ?",
    "unit": "En cm",
    "answer": 15
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Bordeaux ?",
    "unit": "En cm",
    "answer": 23
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Toulouse ?",
    "unit": "En cm",
    "answer": 16
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Grenoble ?",
    "unit": "En cm",
    "answer": 19
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Dijon ?",
    "unit": "En cm",
    "answer": 20
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Marseille ?",
    "unit": "En cm",
    "answer": 24
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Angers ?",
    "unit": "En cm",
    "answer": 25
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Strasbourg ?",
    "unit": "En cm",
    "answer": 19
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Amiens ?",
    "unit": "En cm",
    "answer": 25
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Rennes ?",
    "unit": "En cm",
    "answer": 30
  },
  {
    "type": "WTF",
    "q": "Longueur du plus long poil de nez jamais mesuré à Lille ?",
    "unit": "En cm",
    "answer": 27
  },
  {
    "type": "WTF",
    "q": "Nombre de battements de coeur par minute au repos ?",
    "unit": "En battements",
    "answer": 70
  },
  {
    "type": "WTF",
    "q": "Vitesse à laquelle voyage un éternuement ?",
    "unit": "En km/h",
    "answer": 150
  },
  {
    "type": "WTF",
    "q": "Nombre de calories brûlées en dormant par nuit ?",
    "unit": "En kcal",
    "answer": 500
  },
  {
    "type": "WTF",
    "q": "Longueur de l'ADN d'une seule cellule humaine déroulé ?",
    "unit": "En m",
    "answer": 2
  },
  {
    "type": "WTF",
    "q": "Nombre de gènes dans l'ADN humain ?",
    "unit": "En milliers",
    "answer": 20
  },
  {
    "type": "WTF",
    "q": "Nombre d'espèces de champignons présentes sur un pied humain ?",
    "unit": "En espèces",
    "answer": 80
  },
  {
    "type": "WTF",
    "q": "Nombre d'espèces de microbes vivant sur la peau humaine ?",
    "unit": "En espèces",
    "answer": 1000
  },
  {
    "type": "WTF",
    "q": "Durée de vie moyenne d'un globule rouge ?",
    "unit": "En jours",
    "answer": 120
  },
  {
    "type": "WTF",
    "q": "Nombre de fois qu'on cligne des yeux pendant un film de 2h ?",
    "unit": "En fois",
    "answer": 2400
  },
  {
    "type": "WTF",
    "q": "Durée moyenne d'un bâillement ?",
    "unit": "En secondes",
    "answer": 6
  },
  {
    "type": "WTF",
    "q": "Longueur de l'intestin grêle déplié ?",
    "unit": "En m",
    "answer": 7
  },
  {
    "type": "WTF",
    "q": "Nombre de récepteurs olfactifs (en millions) dans le nez humain ?",
    "unit": "En millions",
    "answer": 20
  },
  {
    "type": "WTF",
    "q": "Nombre de muscles utilisés pour un seul pas de marche ?",
    "unit": "En muscles",
    "answer": 200
  },
  {
    "type": "WTF",
    "q": "Temps nécessaire à un ongle pour repousser entièrement ?",
    "unit": "En mois",
    "answer": 6
  },
  {
    "type": "WTF",
    "q": "Nombre de litres de sang pompés par le coeur en une journée ?",
    "unit": "En litres",
    "answer": 7500
  },
  {
    "type": "WTF",
    "q": "Nombre de fois où l'estomac se renouvelle par an ?",
    "unit": "En fois",
    "answer": 12
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Paris ?",
    "unit": "En jours",
    "answer": 20
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Lyon ?",
    "unit": "En jours",
    "answer": 16
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Marseille ?",
    "unit": "En jours",
    "answer": 22
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Toulouse ?",
    "unit": "En jours",
    "answer": 29
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Nice ?",
    "unit": "En jours",
    "answer": 27
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Nantes ?",
    "unit": "En jours",
    "answer": 21
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Strasbourg ?",
    "unit": "En jours",
    "answer": 20
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Montpellier ?",
    "unit": "En jours",
    "answer": 24
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Bordeaux ?",
    "unit": "En jours",
    "answer": 15
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Lille ?",
    "unit": "En jours",
    "answer": 5
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Rennes ?",
    "unit": "En jours",
    "answer": 16
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Reims ?",
    "unit": "En jours",
    "answer": 27
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Grenoble ?",
    "unit": "En jours",
    "answer": 24
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Dijon ?",
    "unit": "En jours",
    "answer": 24
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Angers ?",
    "unit": "En jours",
    "answer": 21
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Nîmes ?",
    "unit": "En jours",
    "answer": 24
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Tours ?",
    "unit": "En jours",
    "answer": 10
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Amiens ?",
    "unit": "En jours",
    "answer": 18
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Metz ?",
    "unit": "En jours",
    "answer": 4
  },
  {
    "type": "WTF",
    "q": "Durée du plus long hoquet jamais enregistré à Brest ?",
    "unit": "En jours",
    "answer": 14
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Paris ?",
    "unit": "En bâillements",
    "answer": 28
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Lyon ?",
    "unit": "En bâillements",
    "answer": 35
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Marseille ?",
    "unit": "En bâillements",
    "answer": 19
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Toulouse ?",
    "unit": "En bâillements",
    "answer": 21
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Nice ?",
    "unit": "En bâillements",
    "answer": 37
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Nantes ?",
    "unit": "En bâillements",
    "answer": 31
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Strasbourg ?",
    "unit": "En bâillements",
    "answer": 14
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Montpellier ?",
    "unit": "En bâillements",
    "answer": 34
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Bordeaux ?",
    "unit": "En bâillements",
    "answer": 14
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Lille ?",
    "unit": "En bâillements",
    "answer": 30
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Rennes ?",
    "unit": "En bâillements",
    "answer": 14
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Reims ?",
    "unit": "En bâillements",
    "answer": 7
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Grenoble ?",
    "unit": "En bâillements",
    "answer": 22
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Dijon ?",
    "unit": "En bâillements",
    "answer": 9
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Angers ?",
    "unit": "En bâillements",
    "answer": 39
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Nîmes ?",
    "unit": "En bâillements",
    "answer": 8
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Tours ?",
    "unit": "En bâillements",
    "answer": 21
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Amiens ?",
    "unit": "En bâillements",
    "answer": 36
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Metz ?",
    "unit": "En bâillements",
    "answer": 8
  },
  {
    "type": "WTF",
    "q": "Record de bâillements enchaînés à Brest ?",
    "unit": "En bâillements",
    "answer": 22
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de fois où on cligne des yeux par jour ?",
    "unit": "En fois",
    "answer": 15000
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de fois où on respire par jour ?",
    "unit": "En fois",
    "answer": 20000
  },
  {
    "type": "INCONGRU",
    "q": "Longueur totale des vaisseaux sanguins si mis bout à bout ?",
    "unit": "En km",
    "answer": 100000
  },
  {
    "type": "INCONGRU",
    "q": "Poids d'un nuage cumulus moyen ?",
    "unit": "En tonnes",
    "answer": 500
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de sable sur Terre (estimation) ?",
    "unit": "En sextillions",
    "answer": 7
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de fourmis sur Terre ?",
    "unit": "En quadrillions",
    "answer": 20
  },
  {
    "type": "INCONGRU",
    "q": "Masse de toutes les fourmis vs masse de tous les humains ?",
    "unit": "En fois",
    "answer": 1
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de feuilles sur un chêne adulte ?",
    "unit": "En milliers",
    "answer": 250
  },
  {
    "type": "INCONGRU",
    "q": "Hauteur du plus grand arbre (séquoia Hyperion) ?",
    "unit": "En m",
    "answer": 115
  },
  {
    "type": "INCONGRU",
    "q": "Âge du plus vieil arbre (pin Mathusalem) ?",
    "unit": "En années",
    "answer": 4850
  },
  {
    "type": "INCONGRU",
    "q": "Vitesse de croissance du bambou record par jour ?",
    "unit": "En cm",
    "answer": 91
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de battements de coeur d'une baleine bleue par minute ?",
    "unit": "En battements",
    "answer": 6
  },
  {
    "type": "INCONGRU",
    "q": "Pression artérielle d'une girafe ?",
    "unit": "En mmHg",
    "answer": 280
  },
  {
    "type": "INCONGRU",
    "q": "Nombre d'oeufs pondus par une poule par an ?",
    "unit": "En oeufs",
    "answer": 300
  },
  {
    "type": "INCONGRU",
    "q": "Durée de vie d'une poule pondeuse ?",
    "unit": "En années",
    "answer": 8
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de dents d'un escargot ?",
    "unit": "En dents",
    "answer": 14000
  },
  {
    "type": "INCONGRU",
    "q": "Vitesse d'un escargot ?",
    "unit": "En m/h",
    "answer": 50
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de coeurs d'une pieuvre ?",
    "unit": "En coeurs",
    "answer": 3
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de cerveaux d'une pieuvre ?",
    "unit": "En cerveaux",
    "answer": 9
  },
  {
    "type": "INCONGRU",
    "q": "Couleur du sang d'une pieuvre ?",
    "unit": "En couleur (bleu=1)",
    "answer": 1
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de ongles sur un humain ?",
    "unit": "En nombre",
    "answer": 90488
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de cils sur un humain ?",
    "unit": "En nombre",
    "answer": 11651
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de cheveux sur un humain ?",
    "unit": "En nombre",
    "answer": 57204
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de poils sur un humain ?",
    "unit": "En nombre",
    "answer": 51973
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Tours ?",
    "unit": "En grains",
    "answer": 48138
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Metz ?",
    "unit": "En grains",
    "answer": 55394
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Brest ?",
    "unit": "En grains",
    "answer": 55448
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Lille ?",
    "unit": "En grains",
    "answer": 46840
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Marseille ?",
    "unit": "En grains",
    "answer": 43684
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Amiens ?",
    "unit": "En grains",
    "answer": 43381
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Paris ?",
    "unit": "En grains",
    "answer": 49931
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Angers ?",
    "unit": "En grains",
    "answer": 56750
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Rennes ?",
    "unit": "En grains",
    "answer": 50739
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Nîmes ?",
    "unit": "En grains",
    "answer": 56403
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Nice ?",
    "unit": "En grains",
    "answer": 42707
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Dijon ?",
    "unit": "En grains",
    "answer": 43789
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Lyon ?",
    "unit": "En grains",
    "answer": 40170
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Bordeaux ?",
    "unit": "En grains",
    "answer": 55966
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Grenoble ?",
    "unit": "En grains",
    "answer": 54022
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Strasbourg ?",
    "unit": "En grains",
    "answer": 50623
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Montpellier ?",
    "unit": "En grains",
    "answer": 46697
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Reims ?",
    "unit": "En grains",
    "answer": 50106
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Nantes ?",
    "unit": "En grains",
    "answer": 43513
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de grains de riz dans un paquet de 1kg à Toulouse ?",
    "unit": "En grains",
    "answer": 46960
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de smartphones empilés pour atteindre la hauteur de la Tour Eiffel ?",
    "unit": "En smartphones",
    "answer": 2200
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de baguettes de pain mises bout à bout pour faire 1 km ?",
    "unit": "En baguettes",
    "answer": 1500
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de cannettes empilées pour atteindre un immeuble de 10 étages ?",
    "unit": "En cannettes",
    "answer": 250
  },
  {
    "type": "INCONGRU",
    "q": "Nombre d'éléphants pour égaler le poids d'un A380 à vide ?",
    "unit": "En éléphants",
    "answer": 60
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de ballons de baudruche nécessaires pour soulever une personne ?",
    "unit": "En ballons",
    "answer": 10000
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de millions de fourmis pour égaler le poids d'un humain ?",
    "unit": "En millions",
    "answer": 15
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de tours du monde à l'équateur pour égaler la distance Terre-Lune ?",
    "unit": "En tours",
    "answer": 10
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de Tour Eiffel empilées pour atteindre le sommet de l'Everest ?",
    "unit": "En Tour Eiffel",
    "answer": 27
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de terrains de foot pour couvrir Paris intra-muros ?",
    "unit": "En terrains",
    "answer": 14700
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de piscines olympiques pour remplir le Stade de France ?",
    "unit": "En piscines",
    "answer": 40
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de baleines bleues pour égaler le poids de la Tour Eiffel ?",
    "unit": "En baleines",
    "answer": 55
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de smartphones recyclés pour obtenir 1kg d'or ?",
    "unit": "En smartphones",
    "answer": 4000
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de pommes pour égaler le poids d'une Clio ?",
    "unit": "En pommes",
    "answer": 7000
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de girafes empilées pour atteindre le sommet de la Statue de la Liberté ?",
    "unit": "En girafes",
    "answer": 18
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de trottinettes mises bout à bout pour faire 1 km ?",
    "unit": "En trottinettes",
    "answer": 900
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de baignoires pour vider une piscine olympique ?",
    "unit": "En baignoires",
    "answer": 3300
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Paris ?",
    "unit": "En millions",
    "answer": 15
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Lyon ?",
    "unit": "En millions",
    "answer": 47
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Marseille ?",
    "unit": "En millions",
    "answer": 7
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Toulouse ?",
    "unit": "En millions",
    "answer": 44
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Nice ?",
    "unit": "En millions",
    "answer": 16
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Nantes ?",
    "unit": "En millions",
    "answer": 11
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Strasbourg ?",
    "unit": "En millions",
    "answer": 24
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Montpellier ?",
    "unit": "En millions",
    "answer": 2
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Bordeaux ?",
    "unit": "En millions",
    "answer": 37
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Lille ?",
    "unit": "En millions",
    "answer": 8
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Rennes ?",
    "unit": "En millions",
    "answer": 3
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Reims ?",
    "unit": "En millions",
    "answer": 5
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Grenoble ?",
    "unit": "En millions",
    "answer": 11
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Dijon ?",
    "unit": "En millions",
    "answer": 26
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Angers ?",
    "unit": "En millions",
    "answer": 19
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Nîmes ?",
    "unit": "En millions",
    "answer": 3
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Tours ?",
    "unit": "En millions",
    "answer": 21
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Amiens ?",
    "unit": "En millions",
    "answer": 32
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Metz ?",
    "unit": "En millions",
    "answer": 39
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de gouttes de pluie dans une averse d'1 heure à Brest ?",
    "unit": "En millions",
    "answer": 30
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Paris ?",
    "unit": "En nids de poule",
    "answer": 775
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Lyon ?",
    "unit": "En nids de poule",
    "answer": 582
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Marseille ?",
    "unit": "En nids de poule",
    "answer": 496
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Toulouse ?",
    "unit": "En nids de poule",
    "answer": 571
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Nice ?",
    "unit": "En nids de poule",
    "answer": 415
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Nantes ?",
    "unit": "En nids de poule",
    "answer": 196
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Strasbourg ?",
    "unit": "En nids de poule",
    "answer": 152
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Montpellier ?",
    "unit": "En nids de poule",
    "answer": 854
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Bordeaux ?",
    "unit": "En nids de poule",
    "answer": 88
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Lille ?",
    "unit": "En nids de poule",
    "answer": 759
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Rennes ?",
    "unit": "En nids de poule",
    "answer": 454
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Reims ?",
    "unit": "En nids de poule",
    "answer": 464
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Grenoble ?",
    "unit": "En nids de poule",
    "answer": 179
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Dijon ?",
    "unit": "En nids de poule",
    "answer": 692
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Angers ?",
    "unit": "En nids de poule",
    "answer": 543
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Nîmes ?",
    "unit": "En nids de poule",
    "answer": 117
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Tours ?",
    "unit": "En nids de poule",
    "answer": 277
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Amiens ?",
    "unit": "En nids de poule",
    "answer": 105
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Metz ?",
    "unit": "En nids de poule",
    "answer": 766
  },
  {
    "type": "INCONGRU",
    "q": "Nombre de nids de poule sur les routes de Brest ?",
    "unit": "En nids de poule",
    "answer": 618
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de fois où on cligne des yeux par jour ?",
    "unit": "En fois",
    "answer": 15000
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de fois où on respire par jour ?",
    "unit": "En fois",
    "answer": 20000
  },
  {
    "type": "DÉGUEU",
    "q": "Longueur totale des vaisseaux sanguins si mis bout à bout ?",
    "unit": "En km",
    "answer": 100000
  },
  {
    "type": "DÉGUEU",
    "q": "Poids d'un nuage cumulus moyen ?",
    "unit": "En tonnes",
    "answer": 500
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de grains de sable sur Terre (estimation) ?",
    "unit": "En sextillions",
    "answer": 7
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de fourmis sur Terre ?",
    "unit": "En quadrillions",
    "answer": 20
  },
  {
    "type": "DÉGUEU",
    "q": "Masse de toutes les fourmis vs masse de tous les humains ?",
    "unit": "En fois",
    "answer": 1
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de feuilles sur un chêne adulte ?",
    "unit": "En milliers",
    "answer": 250
  },
  {
    "type": "DÉGUEU",
    "q": "Hauteur du plus grand arbre (séquoia Hyperion) ?",
    "unit": "En m",
    "answer": 115
  },
  {
    "type": "DÉGUEU",
    "q": "Âge du plus vieil arbre (pin Mathusalem) ?",
    "unit": "En années",
    "answer": 4850
  },
  {
    "type": "DÉGUEU",
    "q": "Vitesse de croissance du bambou record par jour ?",
    "unit": "En cm",
    "answer": 91
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de battements de coeur d'une baleine bleue par minute ?",
    "unit": "En battements",
    "answer": 6
  },
  {
    "type": "DÉGUEU",
    "q": "Pression artérielle d'une girafe ?",
    "unit": "En mmHg",
    "answer": 280
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre d'oeufs pondus par une poule par an ?",
    "unit": "En oeufs",
    "answer": 300
  },
  {
    "type": "DÉGUEU",
    "q": "Durée de vie d'une poule pondeuse ?",
    "unit": "En années",
    "answer": 8
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de dents d'un escargot ?",
    "unit": "En dents",
    "answer": 14000
  },
  {
    "type": "DÉGUEU",
    "q": "Vitesse d'un escargot ?",
    "unit": "En m/h",
    "answer": 50
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de coeurs d'une pieuvre ?",
    "unit": "En coeurs",
    "answer": 3
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de cerveaux d'une pieuvre ?",
    "unit": "En cerveaux",
    "answer": 9
  },
  {
    "type": "DÉGUEU",
    "q": "Couleur du sang d'une pieuvre ?",
    "unit": "En couleur (bleu=1)",
    "answer": 1
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de cils sur un humain ?",
    "unit": "En nombre",
    "answer": 98717
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de ongles sur un humain ?",
    "unit": "En nombre",
    "answer": 30771
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de cheveux sur un humain ?",
    "unit": "En nombre",
    "answer": 40662
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de poils sur un humain ?",
    "unit": "En nombre",
    "answer": 84140
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Montpellier ?",
    "unit": "En milliards",
    "answer": 50
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Grenoble ?",
    "unit": "En milliards",
    "answer": 27
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Amiens ?",
    "unit": "En milliards",
    "answer": 35
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Metz ?",
    "unit": "En milliards",
    "answer": 12
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Strasbourg ?",
    "unit": "En milliards",
    "answer": 21
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Lille ?",
    "unit": "En milliards",
    "answer": 43
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Tours ?",
    "unit": "En milliards",
    "answer": 29
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Dijon ?",
    "unit": "En milliards",
    "answer": 17
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Bordeaux ?",
    "unit": "En milliards",
    "answer": 33
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Marseille ?",
    "unit": "En milliards",
    "answer": 31
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Brest ?",
    "unit": "En milliards",
    "answer": 10
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Nîmes ?",
    "unit": "En milliards",
    "answer": 32
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Angers ?",
    "unit": "En milliards",
    "answer": 15
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Nantes ?",
    "unit": "En milliards",
    "answer": 37
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Reims ?",
    "unit": "En milliards",
    "answer": 40
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Toulouse ?",
    "unit": "En milliards",
    "answer": 20
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Nice ?",
    "unit": "En milliards",
    "answer": 12
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Rennes ?",
    "unit": "En milliards",
    "answer": 26
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Lyon ?",
    "unit": "En milliards",
    "answer": 21
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une éponge de cuisine à Paris ?",
    "unit": "En milliards",
    "answer": 26
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de fois qu'on avale sa salive par jour ?",
    "unit": "En fois",
    "answer": 600
  },
  {
    "type": "DÉGUEU",
    "q": "Poids de peau morte perdue par semaine ?",
    "unit": "En grammes",
    "answer": 25
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries dans la bouche humaine ?",
    "unit": "En milliards",
    "answer": 20
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur un smartphone (en milliers) ?",
    "unit": "En milliers",
    "answer": 25000
  },
  {
    "type": "DÉGUEU",
    "q": "Quantité de gaz intestinaux produits par jour ?",
    "unit": "En litres",
    "answer": 1
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de fois qu'on pète par jour en moyenne ?",
    "unit": "En fois",
    "answer": 14
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre d'acariens vivant dans un matelas ?",
    "unit": "En millions",
    "answer": 10
  },
  {
    "type": "DÉGUEU",
    "q": "Poids des acariens dans un vieux matelas ?",
    "unit": "En kg",
    "answer": 1
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une brosse à dents (en millions) ?",
    "unit": "En millions",
    "answer": 10
  },
  {
    "type": "DÉGUEU",
    "q": "Quantité de mucus produite par le nez par jour ?",
    "unit": "En litres",
    "answer": 1
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de cellules de peau morte perdues par minute (en milliers) ?",
    "unit": "En milliers",
    "answer": 30
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur un billet de banque (en milliers) ?",
    "unit": "En milliers",
    "answer": 26000
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de fois qu'on se touche le visage par jour ?",
    "unit": "En fois",
    "answer": 23
  },
  {
    "type": "DÉGUEU",
    "q": "Poids des bactéries qui vivent dans l'intestin humain ?",
    "unit": "En kg",
    "answer": 2
  },
  {
    "type": "DÉGUEU",
    "q": "Durée de survie de bactéries sur un clavier d'ordinateur ?",
    "unit": "En jours",
    "answer": 4
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de microbes échangés lors d'un bisou (en millions) ?",
    "unit": "En millions",
    "answer": 80
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Paris ?",
    "unit": "En milliards",
    "answer": 59
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Lyon ?",
    "unit": "En milliards",
    "answer": 57
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Marseille ?",
    "unit": "En milliards",
    "answer": 45
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Toulouse ?",
    "unit": "En milliards",
    "answer": 17
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Nice ?",
    "unit": "En milliards",
    "answer": 29
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Nantes ?",
    "unit": "En milliards",
    "answer": 7
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Strasbourg ?",
    "unit": "En milliards",
    "answer": 52
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Montpellier ?",
    "unit": "En milliards",
    "answer": 33
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Bordeaux ?",
    "unit": "En milliards",
    "answer": 15
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Lille ?",
    "unit": "En milliards",
    "answer": 8
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Rennes ?",
    "unit": "En milliards",
    "answer": 57
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Reims ?",
    "unit": "En milliards",
    "answer": 39
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Grenoble ?",
    "unit": "En milliards",
    "answer": 47
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Dijon ?",
    "unit": "En milliards",
    "answer": 33
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Angers ?",
    "unit": "En milliards",
    "answer": 35
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Nîmes ?",
    "unit": "En milliards",
    "answer": 55
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Tours ?",
    "unit": "En milliards",
    "answer": 27
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Amiens ?",
    "unit": "En milliards",
    "answer": 56
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Metz ?",
    "unit": "En milliards",
    "answer": 25
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de bactéries sur une poignée de porte de toilettes publiques à Brest ?",
    "unit": "En milliards",
    "answer": 36
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Paris ?",
    "unit": "En chewing-gums",
    "answer": 3385
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Lyon ?",
    "unit": "En chewing-gums",
    "answer": 135
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Marseille ?",
    "unit": "En chewing-gums",
    "answer": 3333
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Toulouse ?",
    "unit": "En chewing-gums",
    "answer": 1028
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Nice ?",
    "unit": "En chewing-gums",
    "answer": 3115
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Nantes ?",
    "unit": "En chewing-gums",
    "answer": 3671
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Strasbourg ?",
    "unit": "En chewing-gums",
    "answer": 4988
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Montpellier ?",
    "unit": "En chewing-gums",
    "answer": 1001
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Bordeaux ?",
    "unit": "En chewing-gums",
    "answer": 3216
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Lille ?",
    "unit": "En chewing-gums",
    "answer": 4784
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Rennes ?",
    "unit": "En chewing-gums",
    "answer": 2308
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Reims ?",
    "unit": "En chewing-gums",
    "answer": 1211
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Grenoble ?",
    "unit": "En chewing-gums",
    "answer": 4122
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Dijon ?",
    "unit": "En chewing-gums",
    "answer": 3006
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Angers ?",
    "unit": "En chewing-gums",
    "answer": 3991
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Nîmes ?",
    "unit": "En chewing-gums",
    "answer": 4435
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Tours ?",
    "unit": "En chewing-gums",
    "answer": 3823
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Amiens ?",
    "unit": "En chewing-gums",
    "answer": 649
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Metz ?",
    "unit": "En chewing-gums",
    "answer": 584
  },
  {
    "type": "DÉGUEU",
    "q": "Nombre de chewing-gums collés sous les tables de la mairie de Brest ?",
    "unit": "En chewing-gums",
    "answer": 2196
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Distance moyenne entre la Terre et la Lune ?",
    "unit": "En km",
    "answer": 384400
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Distance moyenne entre la Terre et le Soleil ?",
    "unit": "En millions de km",
    "answer": 150
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Vitesse de la lumière dans le vide ?",
    "unit": "En km/s",
    "answer": 299792
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Âge estimé de l'Univers ?",
    "unit": "En milliards d'années",
    "answer": 14
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre estimé de galaxies dans l'univers observable ?",
    "unit": "En milliards",
    "answer": 2000
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre d'étoiles dans la Voie Lactée ?",
    "unit": "En milliards",
    "answer": 200
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Diamètre de la Voie Lactée ?",
    "unit": "En années-lumière",
    "answer": 100000
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Température à la surface du Soleil ?",
    "unit": "En °C",
    "answer": 5500
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Température au centre du Soleil ?",
    "unit": "En millions de °C",
    "answer": 15
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Distance de Proxima du Centaure, l'étoile la plus proche ?",
    "unit": "En années-lumière",
    "answer": 4
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Temps que met la lumière du Soleil pour arriver sur Terre ?",
    "unit": "En minutes",
    "answer": 8
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Diamètre de Jupiter ?",
    "unit": "En km",
    "answer": 139820
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre de lunes de Saturne connues en 2024 ?",
    "unit": "En lunes",
    "answer": 146
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Masse du Soleil par rapport à la Terre ?",
    "unit": "En fois la Terre",
    "answer": 333000
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Vitesse orbitale de l'ISS ?",
    "unit": "En km/h",
    "answer": 27600
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Altitude moyenne de l'ISS ?",
    "unit": "En km",
    "answer": 400
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Diamètre du trou noir TON 618 ?",
    "unit": "En milliards de km",
    "answer": 390
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Masse de TON 618 en masses solaires ?",
    "unit": "En milliards",
    "answer": 66
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Une année-lumière en milliards de km ?",
    "unit": "En milliards de km",
    "answer": 9461
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Diamètre du Soleil ?",
    "unit": "En km",
    "answer": 1392700
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre de planètes dans le système solaire ?",
    "unit": "En planètes",
    "answer": 8
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Durée d'une année sur Mercure ?",
    "unit": "En jours terrestres",
    "answer": 88
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Durée d'une année sur Mars ?",
    "unit": "En jours terrestres",
    "answer": 687
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Pression atmosphérique sur Mars vs Terre ?",
    "unit": "En % de la Terre",
    "answer": 1
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre de lunes de Jupiter ?",
    "unit": "En lunes",
    "answer": 95
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Distance Voyager 1 de la Terre en 2024 ?",
    "unit": "En milliards de km",
    "answer": 24
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Vitesse de Voyager 1 ?",
    "unit": "En km/h",
    "answer": 61000
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Âge de la Terre ?",
    "unit": "En milliards d'années",
    "answer": 4
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Profondeur de la fosse des Mariannes ?",
    "unit": "En m",
    "answer": 10925
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Hauteur de l'Everest ?",
    "unit": "En m",
    "answer": 8848
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Longueur de l'équateur terrestre ?",
    "unit": "En km",
    "answer": 40075
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Circonférence de la Lune ?",
    "unit": "En km",
    "answer": 10921
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Diamètre de Mars ?",
    "unit": "En km",
    "answer": 6779
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Diamètre de Vénus ?",
    "unit": "En km",
    "answer": 12104
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Température à la surface de Vénus ?",
    "unit": "En °C",
    "answer": 462
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre d'anneaux principaux de Saturne ?",
    "unit": "En anneaux",
    "answer": 7
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Durée d'un jour sur Jupiter ?",
    "unit": "En heures",
    "answer": 10
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Masse de la Terre ?",
    "unit": "En kg (x10^24)",
    "answer": 6
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Masse de Jupiter ?",
    "unit": "En fois la Terre",
    "answer": 318
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Distance entre la Terre et Mars au plus proche ?",
    "unit": "En millions de km",
    "answer": 55
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre d'étoiles dans l'univers observable ?",
    "unit": "En sextillions",
    "answer": 1
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Taille de l'univers observable ?",
    "unit": "En milliards d'années-lumière",
    "answer": 93
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Vitesse de rotation de la Terre à l'équateur ?",
    "unit": "En km/h",
    "answer": 1670
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Inclinaison de l'axe de la Terre ?",
    "unit": "En degrés",
    "answer": 23
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre de galaxies dans le Groupe Local ?",
    "unit": "En galaxies",
    "answer": 54
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Distance d'Andromède ?",
    "unit": "En millions d'années-lumière",
    "answer": 2
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Masse d'un trou noir stellaire moyen ?",
    "unit": "En masses solaires",
    "answer": 10
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Température du fond diffus cosmologique ?",
    "unit": "En K",
    "answer": 3
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Âge du Soleil ?",
    "unit": "En milliards d'années",
    "answer": 5
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Durée de vie restante du Soleil ?",
    "unit": "En milliards d'années",
    "answer": 5
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre de comètes dans le nuage d'Oort ?",
    "unit": "En milliards",
    "answer": 1000
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Taille du plus gros astéroïde Cérès ?",
    "unit": "En km",
    "answer": 940
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Vitesse de libération de la Terre ?",
    "unit": "En km/s",
    "answer": 11
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Énergie libérée par le Soleil par seconde ?",
    "unit": "En x10^26 joules",
    "answer": 4
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre de photons émis par le Soleil par seconde ?",
    "unit": "En x10^44",
    "answer": 10
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Distance du centre de la Voie Lactée au Soleil ?",
    "unit": "En années-lumière",
    "answer": 26000
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Masse du trou noir central de la Voie Lactée ?",
    "unit": "En millions de masses solaires",
    "answer": 4
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre de bras spiraux de la Voie Lactée ?",
    "unit": "En bras",
    "answer": 4
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Vitesse du Soleil autour du centre galactique ?",
    "unit": "En km/s",
    "answer": 230
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Temps pour faire le tour de la galaxie (année galactique) ?",
    "unit": "En millions d'années",
    "answer": 230
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre de systèmes planétaires dans la Voie Lactée ?",
    "unit": "En milliards",
    "answer": 100
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Probabilité estimée de vie ailleurs ?",
    "unit": "En % (Drake)",
    "answer": 50
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre d'atomes dans l'univers observable ?",
    "unit": "En x10^80",
    "answer": 1
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Densité moyenne de l'univers ?",
    "unit": "En atomes/m3",
    "answer": 1
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Température au centre de la Terre ?",
    "unit": "En °C",
    "answer": 6000
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Pression au centre de la Terre ?",
    "unit": "En millions d'atmosphères",
    "answer": 3
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Âge des plus vieilles roches terrestres ?",
    "unit": "En milliards d'années",
    "answer": 4
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre d'extinctions de masse ?",
    "unit": "En extinctions",
    "answer": 5
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Durée d'un jour il y a 1 milliard d'années ?",
    "unit": "En heures",
    "answer": 18
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Distance à laquelle la Lune s'éloigne par an ?",
    "unit": "En cm",
    "answer": 4
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre de marées par jour ?",
    "unit": "En marées",
    "answer": 2
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Hauteur maximale d'une marée (Baie de Fundy) ?",
    "unit": "En m",
    "answer": 16
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Vitesse d'un tsunami en haute mer ?",
    "unit": "En km/h",
    "answer": 800
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Énergie d'un ouragan catégorie 5 ?",
    "unit": "En bombes d'Hiroshima",
    "answer": 10000
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Température la plus chaude enregistrée sur Terre ?",
    "unit": "En °C",
    "answer": 57
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Profondeur moyenne des océans ?",
    "unit": "En m",
    "answer": 3700
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Volume total d'eau sur Terre ?",
    "unit": "En milliards de km3",
    "answer": 1
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Pourcentage d'eau douce sur Terre ?",
    "unit": "En %",
    "answer": 3
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre d'espèces animales connues ?",
    "unit": "En millions",
    "answer": 2
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre total d'espèces estimées sur Terre ?",
    "unit": "En millions",
    "answer": 9
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Masse de tous les humains ?",
    "unit": "En millions de tonnes",
    "answer": 400
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Masse de toutes les fourmis ?",
    "unit": "En millions de tonnes",
    "answer": 12
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre de fourmis sur Terre ?",
    "unit": "En quadrillions",
    "answer": 20
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre de grains de sable sur Terre ?",
    "unit": "En sextillions",
    "answer": 7
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre de feuilles sur un chêne adulte ?",
    "unit": "En milliers",
    "answer": 250
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Hauteur du plus grand arbre (séquoia) ?",
    "unit": "En m",
    "answer": 115
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Âge du plus vieil arbre (Mathusalem) ?",
    "unit": "En années",
    "answer": 4850
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Profondeur maximale d'une racine ?",
    "unit": "En m",
    "answer": 120
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Vitesse de croissance du bambou record ?",
    "unit": "En cm/jour",
    "answer": 91
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre de battements de coeur d'une baleine bleue par minute ?",
    "unit": "En battements",
    "answer": 6
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Pression artérielle d'une girafe ?",
    "unit": "En mmHg",
    "answer": 280
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre d'oeufs pondus par une poule par an ?",
    "unit": "En oeufs",
    "answer": 300
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Durée de vie d'une tortue géante ?",
    "unit": "En années",
    "answer": 175
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Vitesse d'un guépard ?",
    "unit": "En km/h",
    "answer": 110
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Altitude maximale d'un oiseau (vautour) ?",
    "unit": "En m",
    "answer": 11300
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Profondeur de plongée d'un cachalot ?",
    "unit": "En m",
    "answer": 2250
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Nombre de neurones dans le cerveau humain ?",
    "unit": "En milliards",
    "answer": 86
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Vitesse d'un influx nerveux ?",
    "unit": "En km/h",
    "answer": 400
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Distance moyenne entre la Terre et Mars au plus proche ?",
    "unit": "En millions de km",
    "answer": 55
  },
  {
    "type": "IMPOSSIBLE",
    "q": "Diamètre de la planète naine Pluton ?",
    "unit": "En km",
    "answer": 2377
  }
];

const TYPE_WEIGHTS = {
  "PRIX": 5, "POIDS": 5, "DISTANCE": 4, "LONGUEUR": 4, "LOYER": 5,
  "POPULATION": 4, "QUANTITÉ": 4, "FOOD": 3.5, "TEMPS": 3, "PRÉNOM": 3,
  "CORPS": 3, "ANIMAL": 4, "CULTURE": 3, "ABSURDE": 1.5, "WTF": 1,
  "INCONGRU": 1.2, "DÉGUEU": 0.8, "IMPOSSIBLE": 0.5
};
const NORMAL_TYPES = ["PRIX","POIDS","DISTANCE","LONGUEUR","LOYER","POPULATION","QUANTITÉ","FOOD","TEMPS","PRÉNOM","CORPS","ANIMAL","CULTURE"];
const WTF_TYPES = ["WTF","ABSURDE","INCONGRU","DÉGUEU","IMPOSSIBLE"];
const ALL_TYPES = [...NORMAL_TYPES, ...WTF_TYPES];

const DEFAULT_CONFIG = { numRounds: 10, baseTime: 20, autoDelay: 5, wtfRatio: 30, allowedTypes: null };
const ROUND_GRACE_MS = 400;        // marge réseau après la fin du chrono pour recevoir une dernière réponse
const RECONNECT_GRACE_MS = 30000;  // un joueur qui se déconnecte en pleine partie a 30 s pour revenir

// ---------- Utilitaires ----------

// Une question est jouable si elle a une réponse numérique non nulle : avec answer = 0 le calcul
// de score divise par zéro et personne ne peut marquer. (Les données seront revues au fact-check ;
// en attendant on ne tire simplement pas ces questions. La banque elle-même n'est pas modifiée.)
const isPlayable = (q) => !!q && typeof q.q === 'string' && Number.isFinite(q.answer) && q.answer !== 0;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sanitizeConfig(input, base) {
  const out = { ...base };
  if (!input || typeof input !== 'object') return out;
  const clampInt = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  if ('numRounds' in input) out.numRounds = clampInt(input.numRounds, 1, 30, base.numRounds);
  if ('baseTime' in input) out.baseTime = clampInt(input.baseTime, 5, 60, base.baseTime);
  if ('autoDelay' in input) out.autoDelay = clampInt(input.autoDelay, 2, 30, base.autoDelay);
  if ('wtfRatio' in input) out.wtfRatio = clampInt(input.wtfRatio, 0, 100, base.wtfRatio);
  if ('allowedTypes' in input) {
    if (Array.isArray(input.allowedTypes)) {
      const list = [...new Set(input.allowedTypes.filter((t) => ALL_TYPES.includes(t)))];
      out.allowedTypes = list.length ? list : null;
    } else {
      out.allowedTypes = null;
    }
  }
  return out;
}

function pickRandomQuestions(cfg) {
  const numRounds = cfg?.numRounds || 10;
  const wtfRatio = cfg?.wtfRatio ?? 30;
  const allowed = cfg?.allowedTypes || null;

  let pool = QUESTIONS_BANK.filter(isPlayable);
  if (allowed && allowed.length > 0) {
    const filtered = pool.filter((q) => allowed.includes(q.type));
    if (filtered.length > 0) pool = filtered;
  }

  const picked = [];
  const usedTexts = new Set(); // jamais deux fois la même question dans une partie
  const weight = (q) => TYPE_WEIGHTS[q.type] || 1;

  const take = (source, count) => {
    let src = source.filter((q) => !usedTexts.has(q.q));
    for (let n = 0; n < count && src.length > 0; n++) {
      const total = src.reduce((s, q) => s + weight(q), 0);
      let r = Math.random() * total;
      let idx = src.length - 1;
      for (let j = 0; j < src.length; j++) {
        r -= weight(src[j]);
        if (r <= 0) { idx = j; break; }
      }
      const q = src[idx];
      picked.push(q);
      usedTexts.add(q.q);
      src = src.filter((x) => x.q !== q.q);
    }
  };

  const numWtf = Math.round(numRounds * wtfRatio / 100);
  const numNormal = numRounds - numWtf;
  take(pool.filter((q) => NORMAL_TYPES.includes(q.type)), numNormal);
  take(pool.filter((q) => WTF_TYPES.includes(q.type)), numWtf);
  if (picked.length < numRounds) take(pool, numRounds - picked.length); // catégories trop petites : on complète

  return shuffle(picked).slice(0, numRounds);
}

// Accepte 12, "12", "12,5", "1 200", "1 200,5"...
function parseGuess(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function calcPoints(guess, answer) {
  const g = parseGuess(guess);
  if (g === null || !Number.isFinite(answer)) return 0; // pas de réponse valide → 0 point
  const MIN_POINTS = 50; // une réponse donnée, même très éloignée, rapporte toujours un minimum de points
  if (answer === 0) return g === 0 ? 1000 : MIN_POINTS;
  const error = Math.abs(g - answer) / Math.abs(answer);
  const scaled = Math.round(1000 * Math.max(0, 1 - error * 1.5));
  return Math.max(MIN_POINTS, scaled);
}

function getTimeForRound(i, baseTime) {
  baseTime = Number(baseTime) || 20;
  return Math.max(6, baseTime - i * 2 - Math.floor(i / 3));
}

// ---------- État du lobby ----------
// Aucune partie n'existe au démarrage : elle est créée quand l'animateur ouvre son panel / valide ses paramètres.
// Un joueur n'apparaît dans le lobby que lorsqu'il clique sur "Rejoindre" (lobby:join), pas simplement
// parce qu'il a ouvert le site.
const lobby = {
  id: 'main',
  name: 'Lobby Principal',
  isCreated: false,
  createdBy: null,
  createdByName: null,
  players: {},   // id -> { id, username, avatar, ready, connected, socketId, isAnimator, graceTimer }
  roster: {},    // id -> { username, avatar } (survit au départ d'un joueur pour le classement)
  gameState: 'waiting', // waiting | playing
  phase: 'idle',        // idle | starting | question | results
  config: { ...DEFAULT_CONFIG },
  questions: [],
  currentRound: 0,
  answers: {},   // roundIndex -> { playerId: number }
  scores: {},    // playerId -> total
  roundEndsAt: 0,
  roundDuration: 0,
  earlyFinish: false
};

// Tous les timers de partie passent par later() : un reset / une fin de partie les annule tous
// d'un coup, ce qui évite les manches "fantômes" qui redémarrent après un reset.
const runtime = { tick: null, timeouts: new Set(), gameId: 0 };

function clearRuntime() {
  clearInterval(runtime.tick);
  runtime.tick = null;
  runtime.timeouts.forEach((t) => clearTimeout(t));
  runtime.timeouts.clear();
  runtime.gameId++;
}

function later(fn, ms) {
  const id = runtime.gameId;
  const t = setTimeout(() => {
    runtime.timeouts.delete(t);
    if (id === runtime.gameId) fn();
  }, ms);
  runtime.timeouts.add(t);
  return t;
}

function getPlayersArray() {
  return Object.values(lobby.players).map((p) => ({
    id: p.id,
    username: p.username,
    avatar: p.avatar,
    ready: p.ready,
    connected: p.connected,
    isAnimator: p.isAnimator,
    score: lobby.scores[p.id] || 0
  }));
}

function getLobbyPublic() {
  return {
    id: lobby.id,
    name: lobby.name,
    isCreated: lobby.isCreated,
    createdBy: lobby.createdBy,
    createdByName: lobby.createdByName,
    gameState: lobby.gameState,
    config: lobby.config,
    currentRound: lobby.currentRound,
    players: getPlayersArray(),
    totalPlayers: Object.keys(lobby.players).length
  };
}

const broadcastLobby = () => io.to('main').emit('lobby:update', getLobbyPublic());
const broadcastConfig = () => io.to('main').emit('config:update', lobby.config);

const connectedPlayers = () => Object.values(lobby.players).filter((p) => p.connected);

function buildLeaderboard() {
  return Object.entries(lobby.scores)
    .map(([id, score]) => ({
      id,
      username: lobby.roster[id]?.username || 'joueur',
      avatar: lobby.roster[id]?.avatar || null,
      score
    }))
    .sort((a, b) => b.score - a.score);
}

// La question envoyée aux joueurs ne contient JAMAIS la réponse (elle n'est révélée qu'à la fin de la manche).
const publicQuestion = (q) => ({ type: q.type, q: q.q, unit: q.unit });

function roundPayload(i, userId) {
  const remaining = Math.max(0, (lobby.roundEndsAt - Date.now()) / 1000);
  return {
    round: i,
    totalRounds: lobby.questions.length,
    question: publicQuestion(lobby.questions[i]),
    time: Math.round(remaining * 10) / 10,
    totalTime: lobby.roundDuration,
    answered: userId ? (lobby.answers[i] || {})[userId] !== undefined : false
  };
}

// ---------- Déroulement d'une partie ----------
function beginRound(i) {
  if (lobby.gameState !== 'playing') return;
  if (i >= lobby.questions.length) { endGame(); return; }

  lobby.currentRound = i;
  lobby.phase = 'question';
  lobby.earlyFinish = false;
  lobby.answers[i] = {};
  lobby.roundDuration = getTimeForRound(i, lobby.config.baseTime);
  lobby.roundEndsAt = Date.now() + lobby.roundDuration * 1000;

  io.to('players').emit('round:started', roundPayload(i));

  clearInterval(runtime.tick);
  runtime.tick = setInterval(() => {
    const remaining = Math.max(0, (lobby.roundEndsAt - Date.now()) / 1000);
    io.to('players').emit('timer:update', { round: i, timeLeft: Math.ceil(remaining * 10) / 10 });
    if (remaining <= 0) {
      clearInterval(runtime.tick);
      runtime.tick = null;
      later(() => finishRound(i), ROUND_GRACE_MS);
    }
  }, 100);
}

function finishRound(i) {
  // Garde-fou : une manche ne peut être terminée qu'une seule fois (sinon points comptés en double
  // et manche suivante lancée deux fois).
  if (lobby.gameState !== 'playing' || lobby.phase !== 'question' || lobby.currentRound !== i) return;
  lobby.phase = 'results';
  clearInterval(runtime.tick);
  runtime.tick = null;

  const q = lobby.questions[i];
  const roundAnswers = lobby.answers[i] || {};
  const results = [];
  for (const p of Object.values(lobby.players)) {
    const guess = roundAnswers[p.id];
    const points = calcPoints(guess, q.answer);
    lobby.scores[p.id] = (lobby.scores[p.id] || 0) + points;
    results.push({
      id: p.id,
      username: p.username,
      guess: guess === undefined ? null : guess,
      points,
      total: lobby.scores[p.id]
    });
  }
  results.sort((a, b) => b.points - a.points || b.total - a.total);

  io.to('players').emit('round:finished', {
    round: i,
    totalRounds: lobby.questions.length,
    isLast: i + 1 >= lobby.questions.length,
    nextIn: lobby.config.autoDelay,
    question: { type: q.type, q: q.q, unit: q.unit, answer: q.answer },
    correctAnswer: q.answer,
    results,
    leaderboard: buildLeaderboard()
  });

  later(() => beginRound(i + 1), lobby.config.autoDelay * 1000);
}

function endGame() {
  const leaderboard = buildLeaderboard();
  clearRuntime();
  lobby.gameState = 'waiting';
  lobby.phase = 'idle';
  Object.values(lobby.players).forEach((p) => { p.ready = false; });
  io.to('players').emit('game:finished', { leaderboard });
  broadcastLobby();
}

function abortGame() {
  clearRuntime();
  lobby.gameState = 'waiting';
  lobby.phase = 'idle';
  lobby.currentRound = 0;
  lobby.answers = {};
  lobby.scores = {};
  Object.keys(lobby.players).forEach((id) => { lobby.scores[id] = 0; });
  Object.values(lobby.players).forEach((p) => { p.ready = false; });
}

// Si tous les joueurs connectés ont répondu, on n'attend pas la fin du chrono.
function maybeFinishEarly() {
  if (lobby.gameState !== 'playing' || lobby.phase !== 'question' || lobby.earlyFinish) return;
  const active = connectedPlayers();
  if (active.length === 0) return;
  const answers = lobby.answers[lobby.currentRound] || {};
  if (!active.every((p) => answers[p.id] !== undefined)) return;
  lobby.earlyFinish = true;
  clearInterval(runtime.tick);
  runtime.tick = null;
  const round = lobby.currentRound;
  later(() => finishRound(round), 700);
}

// ---------- Joueurs ----------
function createParty(user) {
  if (lobby.isCreated) return;
  lobby.isCreated = true;
  lobby.createdBy = user.id;
  lobby.createdByName = user.username;
  lobby.gameState = 'waiting';
  lobby.phase = 'idle';
  console.log(`Partie créée par l'animateur ${user.username}`);
}

function dissolveParty() {
  lobby.isCreated = false;
  lobby.createdBy = null;
  lobby.createdByName = null;
}

function addPlayer(user, socket) {
  const existing = lobby.players[user.id];
  if (existing && existing.graceTimer) clearTimeout(existing.graceTimer);
  lobby.players[user.id] = {
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    ready: existing ? existing.ready : false,
    connected: true,
    socketId: socket.id,
    isAnimator: isAnimatorUser(user),
    graceTimer: null
  };
  lobby.roster[user.id] = { username: user.username, avatar: user.avatar };
  if (lobby.scores[user.id] === undefined) lobby.scores[user.id] = 0;
  socket.join('players');
  broadcastLobby();
  // Reconnexion / arrivée en pleine manche : on renvoie la manche en cours avec le temps restant.
  if (lobby.gameState === 'playing' && lobby.phase === 'question') {
    socket.emit('round:started', { ...roundPayload(lobby.currentRound, user.id), sync: true });
  }
}

function removePlayer(id) {
  const p = lobby.players[id];
  if (!p) return;
  if (p.graceTimer) clearTimeout(p.graceTimer);
  if (p.isAnimator) {
    // L'animateur quitte : sans lui personne ne peut relancer/configurer la partie,
    // donc elle doit disparaître pour tout le monde même s'il reste des joueurs connectés.
    resetLobby();
    return;
  }
  delete lobby.players[id];
  io.sockets.sockets.forEach((s) => { if (s.user && s.user.id === id) s.leave('players'); });
  if (Object.keys(lobby.players).length === 0) {
    if (lobby.gameState === 'playing') abortGame();
    dissolveParty(); // plus personne : la partie disparaît
  }
  broadcastLobby();
  maybeFinishEarly();
}

function otherLiveSocket(userId, exceptSocketId) {
  let found = null;
  io.sockets.sockets.forEach((s) => {
    if (!found && s.id !== exceptSocketId && s.user && s.user.id === userId) found = s;
  });
  return found;
}

function resetLobby() {
  clearRuntime();
  Object.values(lobby.players).forEach((p) => { if (p.graceTimer) clearTimeout(p.graceTimer); });
  lobby.players = {};
  lobby.roster = {};
  lobby.gameState = 'waiting';
  lobby.phase = 'idle';
  lobby.questions = [];
  lobby.currentRound = 0;
  lobby.answers = {};
  lobby.scores = {};
  dissolveParty();
  io.in('players').socketsLeave('players');
  io.to('main').emit('lobby:closed');
  broadcastLobby();
}

// ---------- OAUTH2 ----------
const cookieOpts = (req, extra = {}) => ({ sameSite: 'lax', secure: !!req.secure, path: '/', ...extra });

app.get('/auth/discord', (req, res) => {
  if (!CLIENT_ID) return res.status(500).send('DISCORD_CLIENT_ID manquant dans le .env');
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('ap_oauth_state', state, cookieOpts(req, { httpOnly: true, maxAge: 10 * 60 * 1000 }));
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  // L'utilisateur a cliqué sur "Annuler" côté Discord (ou pas de code) : retour à l'accueil, pas une page d'erreur brute.
  if (error || !code) return res.redirect('/');
  const expectedState = req.cookies.ap_oauth_state;
  res.clearCookie('ap_oauth_state', { path: '/' });
  if (!expectedState || state !== expectedState) {
    return res.status(400).send('Connexion expirée ou invalide, retourne sur le site et réessaie.');
  }
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: REDIRECT_URI,
      }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const access_token = tokenRes.data.access_token;
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const user = {
      id: String(userRes.data.id),
      username: userRes.data.username,
      avatar: userRes.data.avatar ? `https://cdn.discordapp.com/avatars/${userRes.data.id}/${userRes.data.avatar}.png` : null,
      discriminator: userRes.data.discriminator
    };
    // Cookie signé, httpOnly : c'est lui (et lui seul) qui fait foi côté serveur.
    res.cookie('ap_session', signSession(user), cookieOpts(req, { httpOnly: true, maxAge: SESSION_MAX_AGE_MS }));
    // Cookie lisible par le front (affichage uniquement, jamais utilisé pour décider d'un droit).
    res.cookie('ap_user', JSON.stringify(user), cookieOpts(req, { httpOnly: false, maxAge: SESSION_MAX_AGE_MS }));
    res.redirect(`/?discord_user=${encodeURIComponent(JSON.stringify(user))}#logged`);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).send('Erreur pendant la connexion Discord, retourne sur le site et réessaie.');
  }
});

app.post('/logout', (req, res) => {
  const user = sessionFromReq(req);
  res.clearCookie('ap_user', { path: '/' });
  res.clearCookie('ap_session', { path: '/' });
  if (user && lobby.players[user.id]) removePlayer(user.id);
  res.json({ ok: true });
});

function sessionFromReq(req) {
  return verifySession(req.cookies && req.cookies.ap_session);
}

app.get('/api/me', (req, res) => {
  const user = sessionFromReq(req);
  if (!user) return res.status(401).json({ error: 'not logged' });
  res.json({ ...user, isAnimator: isAnimatorUser(user) });
});

app.get(['/api/lobby', '/api/lobby/:id'], (req, res) => {
  res.json(getLobbyPublic());
});

app.get('/api/config', (req, res) => {
  res.json({
    animatorId: ANIMATOR_ID,
    discordInviteUrl: DISCORD_INVITE_URL,
    port: PORT
  });
});

// Reset complet : réservé à l'animateur connecté (avant, n'importe qui pouvait appeler /api/reset ou /api/create).
app.post('/api/reset', (req, res) => {
  if (!isAnimatorUser(sessionFromReq(req))) return res.status(403).json({ error: 'Réservé à l\'animateur' });
  resetLobby();
  console.log('Lobby reset via /api/reset');
  res.json({ ok: true, lobby: getLobbyPublic() });
});

// ---------- SOCKET.IO ----------
// L'identité vient du cookie de session signé, pas de ce que le client envoie.
io.use((socket, next) => {
  socket.user = verifySession(parseCookieHeader(socket.handshake.headers.cookie).ap_session);
  next();
});

io.on('connection', (socket) => {
  const requireAnimator = () => {
    if (!isAnimatorUser(socket.user)) { socket.emit('error', 'Réservé à l\'animateur'); return false; }
    return true;
  };

  socket.on('auth', () => {
    const user = socket.user;
    if (!user) { socket.emit('auth:error', 'Session expirée, reconnecte-toi avec Discord.'); return; }
    socket.join('main');
    const inLobby = !!lobby.players[user.id];
    socket.emit('auth:ok', {
      user,
      isAnimator: isAnimatorUser(user),
      animatorId: ANIMATOR_ID,
      inLobby,
      gameState: lobby.gameState
    });
    socket.emit('config:update', lobby.config);
    if (inLobby) addPlayer(user, socket); // reconnexion (refresh, coupure réseau) : il reprend sa place
    else socket.emit('lobby:update', getLobbyPublic());
  });

  socket.on('lobby:join', () => {
    const user = socket.user;
    if (!user) { socket.emit('auth:error', 'Session expirée, reconnecte-toi avec Discord.'); return; }
    if (!lobby.isCreated) {
      if (isAnimatorUser(user)) createParty(user);
      else { socket.emit('lobby:closed'); return; }
    }
    socket.join('main');
    addPlayer(user, socket);
  });

  socket.on('lobby:leave', () => {
    if (socket.user) removePlayer(socket.user.id);
  });

  socket.on('player:ready', () => {
    const p = socket.user && lobby.players[socket.user.id];
    if (!p || lobby.gameState === 'playing') return;
    p.ready = !p.ready;
    broadcastLobby();
  });

  socket.on('animator:create', () => {
    if (!requireAnimator()) return;
    const wasCreated = lobby.isCreated;
    createParty(socket.user);
    broadcastLobby();
    if (!wasCreated) io.to('main').emit('party:created', { createdBy: socket.user.username, config: lobby.config });
  });

  // L'animateur ferme son panel sans rejoindre : si personne n'est dans le lobby, la partie s'efface.
  socket.on('animator:cancel', () => {
    if (!requireAnimator()) return;
    if (lobby.isCreated && lobby.gameState !== 'playing' && Object.keys(lobby.players).length === 0) {
      dissolveParty();
      broadcastLobby();
    }
  });

  socket.on('animator:config:update', (newConfig) => {
    if (!requireAnimator()) return;
    if (lobby.gameState === 'playing') {
      socket.emit('error', 'Impossible de modifier les paramètres pendant une partie');
      return;
    }
    createParty(socket.user);
    lobby.config = sanitizeConfig(newConfig, lobby.config);
    broadcastConfig();
    broadcastLobby();
  });

  socket.on('game:launch', () => {
    if (!requireAnimator()) return;
    if (lobby.gameState === 'playing') { socket.emit('error', 'Partie déjà en cours'); return; }
    if (Object.keys(lobby.players).length === 0) { socket.emit('error', 'Aucun joueur dans le lobby'); return; }
    createParty(socket.user);
    const questions = pickRandomQuestions(lobby.config);
    if (questions.length === 0) { socket.emit('error', 'Aucune question disponible'); return; }

    clearRuntime();
    lobby.questions = questions;
    lobby.currentRound = 0;
    lobby.answers = {};
    lobby.scores = {};
    Object.keys(lobby.players).forEach((id) => { lobby.scores[id] = 0; });
    lobby.gameState = 'playing';
    lobby.phase = 'starting';
    console.log(`Partie lancée par ${socket.user.username} : ${questions.length} questions`);
    io.to('players').emit('game:started', { config: lobby.config, totalRounds: questions.length });
    broadcastLobby();
    later(() => beginRound(0), 1000);
  });

  socket.on('game:answer', (payload) => {
    const user = socket.user;
    if (!user || !lobby.players[user.id]) return;
    const { round, answer } = payload || {};
    if (lobby.gameState !== 'playing' || lobby.phase !== 'question') return;
    if (Number(round) !== lobby.currentRound) return;
    if (Date.now() > lobby.roundEndsAt + ROUND_GRACE_MS) return;
    const roundAnswers = lobby.answers[lobby.currentRound] || (lobby.answers[lobby.currentRound] = {});
    if (roundAnswers[user.id] !== undefined) return; // déjà répondu : on ignore

    const num = parseGuess(answer);
    if (num === null) { socket.emit('answer:rejected', { round: lobby.currentRound, reason: 'Réponse invalide' }); return; }
    roundAnswers[user.id] = num;

    const active = connectedPlayers();
    io.to('players').emit('player:answered', {
      round: lobby.currentRound,
      answeredCount: active.filter((p) => roundAnswers[p.id] !== undefined).length,
      totalPlayers: active.length,
      playerId: user.id
    });
    maybeFinishEarly();
  });

  socket.on('game:reset', () => {
    if (!requireAnimator()) return;
    abortGame();
    io.to('players').emit('game:reset');
    broadcastLobby();
    console.log('Partie réinitialisée par l\'animateur');
  });

  socket.on('disconnect', () => {
    const user = socket.user;
    if (!user) return;
    const p = lobby.players[user.id];
    if (!p) return;
    // Même joueur connecté dans un autre onglet / après un refresh : on ne le retire pas.
    const other = otherLiveSocket(user.id, socket.id);
    if (other) { p.socketId = other.id; return; }
    if (p.socketId !== socket.id) return;
    console.log(`Joueur déconnecté : ${user.username}`);
    if (lobby.gameState === 'playing') {
      p.connected = false;
      broadcastLobby();
      maybeFinishEarly();
      p.graceTimer = setTimeout(() => {
        const cur = lobby.players[user.id];
        if (cur && !cur.connected) removePlayer(user.id);
      }, RECONNECT_GRACE_MS);
    } else {
      removePlayer(user.id);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n✅ Serveur à peu près prêt (MULTIJOUEUR) sur http://localhost:${PORT}`);
  console.log(`→ Animator ID: ${ANIMATOR_ID}`);
  console.log(`→ Discord Invite: ${DISCORD_INVITE_URL}`);
  console.log(`→ Login Discord: http://localhost:${PORT}/auth/discord`);
  console.log(`→ Front: http://localhost:${PORT}/\n`);
});
