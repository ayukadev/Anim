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
{type:"PRIX",q:"Un café allongé en terrasse à Paris ?",unit:"En €",answer:3},
{type:"PRIX",q:"Un menu Best Of Big Mac + frites + boisson sur place ?",unit:"En €",answer:9},
{type:"PRIX",q:"Une baguette tradition chez un artisan boulanger ?",unit:"En €",answer:2},
{type:"PRIX",q:"Une pinte de blonde 50cl en bar à Paris ?",unit:"En €",answer:8},
{type:"PRIX",q:"Un ticket de métro T+ à Paris ?",unit:"En €",answer:2},
{type:"PRIX",q:"Une place de cinéma plein tarif Pathé ?",unit:"En €",answer:15},
{type:"PRIX",q:"Un abonnement Netflix Premium par mois ?",unit:"En €",answer:20},
{type:"PRIX",q:"Un abonnement Spotify Duo par mois ?",unit:"En €",answer:15},
{type:"PRIX",q:"Un iPhone 15 128Go neuf ?",unit:"En €",answer:970},
{type:"PRIX",q:"Un MacBook Air M2 256Go neuf ?",unit:"En €",answer:1299},
{type:"PRIX",q:"Une PS5 Standard neuve ?",unit:"En €",answer:500},
{type:"PRIX",q:"Une Nintendo Switch OLED neuve ?",unit:"En €",answer:330},
{type:"PRIX",q:"Une paire de Nike Air Force 1 Low ?",unit:"En €",answer:120},
{type:"PRIX",q:"Un plein de 50L de SP95 ?",unit:"En €",answer:95},
{type:"PRIX",q:"Un paquet de Marlboro Rouge ?",unit:"En €",answer:12},
{type:"PRIX",q:"Une coupe homme chez un barber à Paris ?",unit:"En €",answer:25},
{type:"PRIX",q:"Un abonnement Basic-Fit Confort par mois ?",unit:"En €",answer:26},
{type:"PRIX",q:"Une course Uber X de 5km à Paris ?",unit:"En €",answer:16},
{type:"PRIX",q:"Un menu Big Mac + McFlurry livré Uber Eats avec frais ?",unit:"En €",answer:18},
{type:"PRIX",q:"Des AirPods Pro 2e génération ?",unit:"En €",answer:279},
{type:"PRIX",q:"Un caddie moyen Lidl pour 2 personnes pour 1 semaine ?",unit:"En €",answer:85},
{type:"PRIX",q:"Un kebab complet avec frites ?",unit:"En €",answer:8},
{type:"PRIX",q:"Un tacos 3 viandes + frites ?",unit:"En €",answer:10},
{type:"PRIX",q:"Une pizza Margherita 30cm à emporter ?",unit:"En €",answer:9},
{type:"PRIX",q:"Un croissant pur beurre en boulangerie ?",unit:"En €",answer:1},
{type:"PRIX",q:"Un pain au chocolat en boulangerie ?",unit:"En €",answer:1},
{type:"PRIX",q:"Un iPhone 15 Pro Max 256Go ?",unit:"En €",answer:1470},
{type:"PRIX",q:"Un MacBook Pro 14 pouces M3 ?",unit:"En €",answer:2200},
{type:"PRIX",q:"Une trottinette Xiaomi Electric Scooter 4 ?",unit:"En €",answer:499},
{type:"PRIX",q:"Un vélo électrique Decathlon 500E ?",unit:"En €",answer:999},
{type:"PRIX",q:"Un abonnement ChatGPT Plus ?",unit:"En €",answer:20},
{type:"PRIX",q:"Une entrée Louvre plein tarif ?",unit:"En €",answer:22},
{type:"PRIX",q:"Un sandwich jambon-beurre à Paris ?",unit:"En €",answer:6},
{type:"PRIX",q:"Un cocktail Spritz en terrasse ?",unit:"En €",answer:11},
{type:"PRIX",q:"Un paquet de pâtes 500g ?",unit:"En €",answer:1},
{type:"PRIX",q:"Un kilo de poulet Label Rouge ?",unit:"En €",answer:12},
{type:"PRIX",q:"Un litre de lait demi-écrémé ?",unit:"En €",answer:1},
{type:"PRIX",q:"Un abonnement Le Monde numérique ?",unit:"En €",answer:18},
{type:"PRIX",q:"Une manette PS5 DualSense ?",unit:"En €",answer:70},
{type:"PRIX",q:"Un jeu PS5 neuf ?",unit:"En €",answer:70},
{type:"PRIX",q:"Un billet TGV Paris-Lyon acheté à l'avance ?",unit:"En €",answer:45},
{type:"PRIX",q:"Un vol Paris-Nice aller simple ?",unit:"En €",answer:60},
{type:"PRIX",q:"Un sandwich triangle en gare ?",unit:"En €",answer:5},
{type:"PRIX",q:"Un Red Bull 25cl en bar ?",unit:"En €",answer:6},
{type:"PRIX",q:"Un kebab Uber Eats avec frites et boisson livré ?",unit:"En €",answer:16},
{type:"PRIX",q:"Une bouteille Evian 1,5L ?",unit:"En €",answer:1},
{type:"PRIX",q:"Un pack de 6 oeufs plein air ?",unit:"En €",answer:4},
{type:"PRIX",q:"Un kilo de tomates cerises ?",unit:"En €",answer:6},
{type:"PRIX",q:"Un abonnement Deezer Premium ?",unit:"En €",answer:12},
{type:"PRIX",q:"Un MacBook Air 15 pouces M2 ?",unit:"En €",answer:1550},
{type:"PRIX",q:"Un iPad 10e génération 64Go ?",unit:"En €",answer:440},
{type:"PRIX",q:"Un casque Sony WH-1000XM5 ?",unit:"En €",answer:350},
{type:"PRIX",q:"Un forfait Free 100Go ?",unit:"En €",answer:20},
{type:"PRIX",q:"Un litre d'huile d'olive extra vierge ?",unit:"En €",answer:10},
{type:"PRIX",q:"Un pot Nutella 750g ?",unit:"En €",answer:6},
{type:"PRIX",q:"Un Happy Meal McDo ?",unit:"En €",answer:5},
{type:"PRIX",q:"Un Whopper chez Burger King ?",unit:"En €",answer:7},
{type:"PRIX",q:"Un café Starbucks Tall filtre ?",unit:"En €",answer:4},
{type:"PRIX",q:"Un bubble tea classique ?",unit:"En €",answer:6},
{type:"PRIX",q:"Une assiette kebab avec frites ?",unit:"En €",answer:12},
{type:"PRIX",q:"Un tacos M 1 viande ?",unit:"En €",answer:7},
{type:"PRIX",q:"Un grec complet + canette en formule ?",unit:"En €",answer:9},
{type:"PRIX",q:"Un panier Franprix pour 1 personne ?",unit:"En €",answer:42},
{type:"PRIX",q:"Un ticket RER Paris-La Défense ?",unit:"En €",answer:3},
{type:"PRIX",q:"Un pass Navigo toutes zones mensuel ?",unit:"En €",answer:86},
{type:"PRIX",q:"Un abonnement Vélib' annuel ?",unit:"En €",answer:37},
{type:"PRIX",q:"Un cours de sport à l'unité Basic-Fit ?",unit:"En €",answer:18},
{type:"PRIX",q:"Un paquet de chips Lay's 300g ?",unit:"En €",answer:3},
{type:"PRIX",q:"Un Kinder Bueno x2 ?",unit:"En €",answer:1},
{type:"PRIX",q:"Un McFlurry Oreo ?",unit:"En €",answer:4},
{type:"PRIX",q:"Une glace 2 boules Amorino ?",unit:"En €",answer:7},
{type:"PRIX",q:"Un kebab vegan complet ?",unit:"En €",answer:9},
{type:"PRIX",q:"Un burger artisan en restaurant ?",unit:"En €",answer:17},
{type:"PRIX",q:"Un brunch à Paris le dimanche ?",unit:"En €",answer:26},
{type:"PRIX",q:"Une Corona 33cl en supermarché ?",unit:"En €",answer:1},
{type:"PRIX",q:"Un pack 6 Heineken 25cl ?",unit:"En €",answer:6},
{type:"PRIX",q:"Une bouteille rosé Côtes de Provence 75cl ?",unit:"En €",answer:10},
{type:"PRIX",q:"Un livre poche Folio neuf ?",unit:"En €",answer:9},
{type:"PRIX",q:"Un vinyle neuf standard ?",unit:"En €",answer:28},
{type:"PRIX",q:"Un t-shirt Uniqlo U blanc ?",unit:"En €",answer:15},
{type:"PRIX",q:"Un jean Levi's 501 neuf ?",unit:"En €",answer:120},
{type:"PRIX",q:"Une paire de Converse Chuck Taylor ?",unit:"En €",answer:80},
{type:"PRIX",q:"Un chargeur Apple USB-C 20W ?",unit:"En €",answer:25},
{type:"PRIX",q:"Une Apple Watch SE 2023 ?",unit:"En €",answer:279},
{type:"PRIX",q:"Un jeu Switch neuf ?",unit:"En €",answer:55},
{type:"PRIX",q:"Un abonnement Nintendo Online Famille par an ?",unit:"En €",answer:35},
{type:"PRIX",q:"Un ticket de bus à Lyon ?",unit:"En €",answer:2},
{type:"PRIX",q:"Un croque-monsieur en brasserie ?",unit:"En €",answer:10},
{type:"PRIX",q:"Un steak-frites en brasserie parisienne ?",unit:"En €",answer:21},
{type:"PRIX",q:"Un café + croissant formule matinale ?",unit:"En €",answer:5},
{type:"PRIX",q:"Un paquet Haribo Dragibus 300g ?",unit:"En €",answer:2},
{type:"PRIX",q:"Un menu tacos XL + boisson ?",unit:"En €",answer:12},
{type:"PRIX",q:"Un sandwich triangle poulet en boulangerie ?",unit:"En €",answer:5},
{type:"PRIX",q:"Une bouteille de champagne entrée de gamme ?",unit:"En €",answer:25},
{type:"PRIX",q:"Un pot de glace Häagen-Dazs 500ml ?",unit:"En €",answer:7},
{type:"PRIX",q:"Une entrée au zoo de Beauval adulte ?",unit:"En €",answer:37},
{type:"PRIX",q:"Un ticket Parc Astérix adulte ?",unit:"En €",answer:60},
{type:"PRIX",q:"Un abonnement Canal+ Sport ?",unit:"En €",answer:35},
{type:"PRIX",q:"Un plein de granulés bois 15kg ?",unit:"En €",answer:8},
{type:"PRIX",q:"Un litre d'essence SP98 ?",unit:"En €",answer:2},
{type:"POIDS",q:"Poids d'un éléphant d'Afrique mâle adulte ?",unit:"En kg",answer:6000},
{type:"POIDS",q:"Poids d'une baleine bleue adulte ?",unit:"En kg",answer:130000},
{type:"POIDS",q:"Poids d'un ours polaire mâle ?",unit:"En kg",answer:500},
{type:"POIDS",q:"Poids d'un hippopotame adulte ?",unit:"En kg",answer:1500},
{type:"POIDS",q:"Poids d'une girafe adulte ?",unit:"En kg",answer:1200},
{type:"POIDS",q:"Poids d'un lion mâle adulte ?",unit:"En kg",answer:190},
{type:"POIDS",q:"Poids d'une Renault Clio 5 à vide ?",unit:"En kg",answer:1180},
{type:"POIDS",q:"Poids d'une Tesla Model 3 ?",unit:"En kg",answer:1830},
{type:"POIDS",q:"Poids d'un frigo américain vide ?",unit:"En kg",answer:110},
{type:"POIDS",q:"Poids d'un piano à queue de concert ?",unit:"En kg",answer:500},
{type:"POIDS",q:"Poids moyen d'un homme adulte en France ?",unit:"En kg",answer:81},
{type:"POIDS",q:"Poids d'un bébé à la naissance ?",unit:"En kg",answer:3},
{type:"POIDS",q:"Poids d'un sac de ciment standard ?",unit:"En kg",answer:25},
{type:"POIDS",q:"Poids d'un vélo électrique moyen ?",unit:"En kg",answer:24},
{type:"POIDS",q:"Poids d'un canapé 3 places ?",unit:"En kg",answer:85},
{type:"POIDS",q:"Poids d'un anaconda vert adulte ?",unit:"En kg",answer:100},
{type:"POIDS",q:"Poids d'un grand requin blanc ?",unit:"En kg",answer:1100},
{type:"POIDS",q:"Poids d'un gorille dos argenté ?",unit:"En kg",answer:180},
{type:"POIDS",q:"Poids d'une vache laitière ?",unit:"En kg",answer:700},
{type:"POIDS",q:"Poids d'un cheval de course ?",unit:"En kg",answer:500},
{type:"POIDS",q:"Poids d'une moto Harley Street Glide ?",unit:"En kg",answer:370},
{type:"POIDS",q:"Poids d'un lave-linge 8kg ?",unit:"En kg",answer:70},
{type:"POIDS",q:"Poids d'un micro-ondes ?",unit:"En kg",answer:14},
{type:"POIDS",q:"Poids d'un ballon de foot ?",unit:"En kg",answer:0},
{type:"POIDS",q:"Poids d'une table de ping-pong ?",unit:"En kg",answer:80},
{type:"POIDS",q:"Poids d'une bouteille d'eau 1,5L pleine ?",unit:"En kg",answer:2},
{type:"POIDS",q:"Poids d'un MacBook Pro 14 pouces ?",unit:"En kg",answer:2},
{type:"POIDS",q:"Poids d'une valise cabine vide ?",unit:"En kg",answer:3},
{type:"POIDS",q:"Poids d'un sac à dos rempli pour les cours ?",unit:"En kg",answer:6},
{type:"POIDS",q:"Poids d'un grizzli mâle ?",unit:"En kg",answer:350},
{type:"POIDS",q:"Poids d'un panda géant ?",unit:"En kg",answer:110},
{type:"POIDS",q:"Poids d'un kangourou roux mâle ?",unit:"En kg",answer:90},
{type:"POIDS",q:"Poids d'une autruche ?",unit:"En kg",answer:130},
{type:"POIDS",q:"Poids d'un thon rouge de 2m ?",unit:"En kg",answer:250},
{type:"POIDS",q:"Poids d'un crocodile du Nil ?",unit:"En kg",answer:500},
{type:"POIDS",q:"Poids d'un rhinocéros blanc ?",unit:"En kg",answer:2300},
{type:"POIDS",q:"Poids d'un bison d'Amérique ?",unit:"En kg",answer:900},
{type:"POIDS",q:"Poids d'un morse mâle ?",unit:"En kg",answer:1200},
{type:"POIDS",q:"Poids d'un berger allemand ?",unit:"En kg",answer:35},
{type:"POIDS",q:"Poids d'un Maine Coon mâle ?",unit:"En kg",answer:8},
{type:"POIDS",q:"Poids d'un dauphin commun ?",unit:"En kg",answer:200},
{type:"POIDS",q:"Poids d'un loup gris ?",unit:"En kg",answer:45},
{type:"POIDS",q:"Poids d'un chameau ?",unit:"En kg",answer:600},
{type:"POIDS",q:"Poids d'un orang-outan mâle ?",unit:"En kg",answer:85},
{type:"POIDS",q:"Poids d'une tortue géante des Galápagos ?",unit:"En kg",answer:250},
{type:"POIDS",q:"Poids d'un python réticulé de 6m ?",unit:"En kg",answer:80},
{type:"POIDS",q:"Poids d'un albatros hurleur ?",unit:"En kg",answer:10},
{type:"POIDS",q:"Poids d'un oeuf d'autruche ?",unit:"En kg",answer:1},
{type:"POIDS",q:"Poids d'une pastèque moyenne ?",unit:"En kg",answer:5},
{type:"POIDS",q:"Poids d'une brique creuse ?",unit:"En kg",answer:3},
{type:"POIDS",q:"Poids d'un parpaing 20cm ?",unit:"En kg",answer:18},
{type:"POIDS",q:"Poids d'un pneu de voiture 205/55 ?",unit:"En kg",answer:9},
{type:"POIDS",q:"Poids d'un vélo de route carbone ?",unit:"En kg",answer:8},
{type:"POIDS",q:"Poids d'un snowboard adulte ?",unit:"En kg",answer:4},
{type:"POIDS",q:"Poids d'un surf longboard 9 pieds ?",unit:"En kg",answer:7},
{type:"POIDS",q:"Poids d'un kayak simple ?",unit:"En kg",answer:20},
{type:"POIDS",q:"Poids d'un trampoline 3m ?",unit:"En kg",answer:60},
{type:"POIDS",q:"Poids d'une télé 55 pouces OLED ?",unit:"En kg",answer:18},
{type:"POIDS",q:"Poids d'une barre olympique à vide ?",unit:"En kg",answer:20},
{type:"POIDS",q:"Poids d'un sac de boxe 1m50 ?",unit:"En kg",answer:35},
{type:"POIDS",q:"Poids d'un ballon de basket ?",unit:"En kg",answer:0},
{type:"POIDS",q:"Poids d'un casque de moto intégral ?",unit:"En kg",answer:2},
{type:"POIDS",q:"Poids d'une paire de skis alpins ?",unit:"En kg",answer:5},
{type:"POIDS",q:"Poids d'une paire de running ?",unit:"En kg",answer:0},
{type:"POIDS",q:"Poids d'un pack de 6 bouteilles 1,5L ?",unit:"En kg",answer:9},
{type:"POIDS",q:"Poids d'une caisse de 24 bières 25cl ?",unit:"En kg",answer:16},
{type:"POIDS",q:"Poids d'un poulet entier cru ?",unit:"En kg",answer:1},
{type:"POIDS",q:"Poids d'une dinde de Noël 3kg ?",unit:"En kg",answer:3},
{type:"POIDS",q:"Poids d'un ananas moyen ?",unit:"En kg",answer:1},
{type:"POIDS",q:"Poids d'un sac de pommes de terre 5kg ?",unit:"En kg",answer:5},
{type:"POIDS",q:"Poids d'un pot Nutella 1kg ?",unit:"En kg",answer:1},
{type:"POIDS",q:"Poids d'une bouteille de champagne 75cl pleine ?",unit:"En kg",answer:2},
{type:"POIDS",q:"Poids d'une guitare acoustique ?",unit:"En kg",answer:2},
{type:"POIDS",q:"Poids d'une batterie 5 fûts ?",unit:"En kg",answer:50},
{type:"POIDS",q:"Poids d'une harpe de concert ?",unit:"En kg",answer:36},
{type:"POIDS",q:"Poids d'un violoncelle 4/4 ?",unit:"En kg",answer:3},
{type:"POIDS",q:"Poids d'un frigo top 120L ?",unit:"En kg",answer:32},
{type:"POIDS",q:"Poids d'un four micro-ondes combiné ?",unit:"En kg",answer:20},
{type:"POIDS",q:"Poids d'un aspirateur Dyson V15 ?",unit:"En kg",answer:3},
{type:"POIDS",q:"Poids d'une machine à café Nespresso ?",unit:"En kg",answer:3},
{type:"POIDS",q:"Poids d'un écran 27 pouces ?",unit:"En kg",answer:6},
{type:"POIDS",q:"Poids d'une chaise de bureau ergonomique ?",unit:"En kg",answer:18},
{type:"POIDS",q:"Poids d'un bureau 140cm en bois ?",unit:"En kg",answer:35},
{type:"POIDS",q:"Poids d'un matelas 140x190 mousse ?",unit:"En kg",answer:18},
{type:"POIDS",q:"Poids d'une couette 240x260 ?",unit:"En kg",answer:3},
{type:"POIDS",q:"Poids d'un dictionnaire Le Robert ?",unit:"En kg",answer:2},
{type:"POIDS",q:"Poids d'un pack de 500 feuilles A4 80g ?",unit:"En kg",answer:2},
{type:"POIDS",q:"Poids d'un sac de croquettes chien 15kg ?",unit:"En kg",answer:15},
{type:"POIDS",q:"Poids d'un pack d'eau 6x1,5L ?",unit:"En kg",answer:9},
{type:"POIDS",q:"Poids d'une bouteille de gaz butane 13kg pleine ?",unit:"En kg",answer:26},
{type:"POIDS",q:"Poids d'un vélo enfant 20 pouces ?",unit:"En kg",answer:10},
{type:"POIDS",q:"Poids d'un jerrican d'essence 20L plein ?",unit:"En kg",answer:16},
{type:"POIDS",q:"Poids d'un ordinateur tour gamer ?",unit:"En kg",answer:12},
{type:"POIDS",q:"Poids d'un tableau Ikea 100x70cm ?",unit:"En kg",answer:3},
{type:"POIDS",q:"Poids d'un barbecue Weber charbon 57cm ?",unit:"En kg",answer:20},
{type:"POIDS",q:"Poids d'un sac de charbon 10kg ?",unit:"En kg",answer:10},
{type:"POIDS",q:"Poids d'une roue de secours galette ?",unit:"En kg",answer:12},
{type:"POIDS",q:"Poids d'un moteur de voiture 4 cylindres ?",unit:"En kg",answer:120},
{type:"POIDS",q:"Poids d'un fauteuil club en cuir ?",unit:"En kg",answer:35},
{type:"POIDS",q:"Poids d'un billard américain 8ft ?",unit:"En kg",answer:250},
{type:"DISTANCE",q:"Distance autoroute Paris - Lyon ?",unit:"En km",answer:460},
{type:"DISTANCE",q:"Distance Paris - Marseille par autoroute ?",unit:"En km",answer:775},
{type:"DISTANCE",q:"Distance Paris - Bordeaux par A10 ?",unit:"En km",answer:584},
{type:"DISTANCE",q:"Distance Paris - Lille ?",unit:"En km",answer:225},
{type:"DISTANCE",q:"Distance Paris - Toulouse ?",unit:"En km",answer:680},
{type:"DISTANCE",q:"Distance Paris - Nice ?",unit:"En km",answer:930},
{type:"DISTANCE",q:"Distance Paris - Nantes ?",unit:"En km",answer:385},
{type:"DISTANCE",q:"Distance Paris - Strasbourg ?",unit:"En km",answer:490},
{type:"DISTANCE",q:"Distance Paris - Rennes ?",unit:"En km",answer:350},
{type:"DISTANCE",q:"Distance Paris - Brest ?",unit:"En km",answer:590},
{type:"DISTANCE",q:"Distance Paris - Clermont-Ferrand ?",unit:"En km",answer:420},
{type:"DISTANCE",q:"Distance Paris - Dijon ?",unit:"En km",answer:315},
{type:"DISTANCE",q:"Distance Paris - Grenoble ?",unit:"En km",answer:570},
{type:"DISTANCE",q:"Distance Paris - Biarritz ?",unit:"En km",answer:780},
{type:"DISTANCE",q:"Distance Paris - Perpignan ?",unit:"En km",answer:850},
{type:"DISTANCE",q:"Distance Paris - Le Havre ?",unit:"En km",answer:200},
{type:"DISTANCE",q:"Distance Paris - Reims ?",unit:"En km",answer:145},
{type:"DISTANCE",q:"Distance Paris - Calais ?",unit:"En km",answer:295},
{type:"DISTANCE",q:"Distance Paris - Tours ?",unit:"En km",answer:240},
{type:"DISTANCE",q:"Distance Paris - Orléans ?",unit:"En km",answer:130},
{type:"DISTANCE",q:"Distance Paris - Metz ?",unit:"En km",answer:330},
{type:"DISTANCE",q:"Distance Paris - Angers ?",unit:"En km",answer:300},
{type:"DISTANCE",q:"Distance Lyon - Marseille ?",unit:"En km",answer:315},
{type:"DISTANCE",q:"Distance Lyon - Toulouse ?",unit:"En km",answer:540},
{type:"DISTANCE",q:"Distance Lyon - Nice ?",unit:"En km",answer:450},
{type:"DISTANCE",q:"Distance Lyon - Bordeaux ?",unit:"En km",answer:550},
{type:"DISTANCE",q:"Distance Bordeaux - Toulouse ?",unit:"En km",answer:245},
{type:"DISTANCE",q:"Distance Marseille - Nice ?",unit:"En km",answer:200},
{type:"DISTANCE",q:"Distance Marseille - Montpellier ?",unit:"En km",answer:180},
{type:"DISTANCE",q:"Distance Lille - Bruxelles ?",unit:"En km",answer:120},
{type:"DISTANCE",q:"Distance Paris - Bruxelles ?",unit:"En km",answer:320},
{type:"DISTANCE",q:"Distance Paris - Londres ?",unit:"En km",answer:470},
{type:"DISTANCE",q:"Distance Paris - Barcelone ?",unit:"En km",answer:1050},
{type:"DISTANCE",q:"Distance Paris - Milan ?",unit:"En km",answer:850},
{type:"DISTANCE",q:"Distance totale Tour de France 2024 ?",unit:"En km",answer:3498},
{type:"DISTANCE",q:"Distance d'un marathon ?",unit:"En km",answer:42},
{type:"DISTANCE",q:"Largeur de la Manche au plus étroit ?",unit:"En km",answer:34},
{type:"DISTANCE",q:"Longueur du périphérique parisien ?",unit:"En km",answer:35},
{type:"DISTANCE",q:"Distance Paris - Versailles ?",unit:"En km",answer:22},
{type:"DISTANCE",q:"Distance Lyon - Grenoble ?",unit:"En km",answer:110},
{type:"DISTANCE",q:"Distance Nantes - Rennes ?",unit:"En km",answer:115},
{type:"DISTANCE",q:"Distance Toulouse - Montpellier ?",unit:"En km",answer:245},
{type:"DISTANCE",q:"Distance Bordeaux - Biarritz ?",unit:"En km",answer:200},
{type:"DISTANCE",q:"Distance Paris - New York à vol d'oiseau ?",unit:"En km",answer:5840},
{type:"DISTANCE",q:"Distance Paris - Tokyo à vol d'oiseau ?",unit:"En km",answer:9720},
{type:"DISTANCE",q:"Longueur de la Seine ?",unit:"En km",answer:777},
{type:"DISTANCE",q:"Longueur de la Loire ?",unit:"En km",answer:1012},
{type:"DISTANCE",q:"Tour du monde à l'équateur ?",unit:"En km",answer:40075},
{type:"DISTANCE",q:"Distance Paris - Le Mans ?",unit:"En km",answer:210},
{type:"DISTANCE",q:"Distance Paris - Deauville ?",unit:"En km",answer:200},
{type:"DISTANCE",q:"Distance Paris - Chamonix ?",unit:"En km",answer:610},
{type:"DISTANCE",q:"Distance Paris - Annecy ?",unit:"En km",answer:540},
{type:"DISTANCE",q:"Distance Paris - La Rochelle ?",unit:"En km",answer:480},
{type:"DISTANCE",q:"Distance Paris - Saint-Tropez ?",unit:"En km",answer:890},
{type:"DISTANCE",q:"Distance Paris - Avignon ?",unit:"En km",answer:690},
{type:"DISTANCE",q:"Distance entre deux stations de métro à Paris en moyenne ?",unit:"En km",answer:0},
{type:"DISTANCE",q:"Longueur du Pont de Normandie ?",unit:"En km",answer:2},
{type:"DISTANCE",q:"Longueur du viaduc de Millau ?",unit:"En km",answer:2},
{type:"DISTANCE",q:"Distance Paris - Berlin ?",unit:"En km",answer:1050},
{type:"DISTANCE",q:"Distance Paris - Rome ?",unit:"En km",answer:1110},
{type:"DISTANCE",q:"Distance Paris - Madrid ?",unit:"En km",answer:1270},
{type:"DISTANCE",q:"Distance Paris - Amsterdam ?",unit:"En km",answer:510},
{type:"DISTANCE",q:"Distance Lyon - Paris en TGV (rail) ?",unit:"En km",answer:430},
{type:"DISTANCE",q:"Distance Terre - Lune ?",unit:"En km",answer:384400},
{type:"DISTANCE",q:"Distance Paris - Mont Saint-Michel ?",unit:"En km",answer:360},
{type:"DISTANCE",q:"Distance Paris - Étretat ?",unit:"En km",answer:205},
{type:"DISTANCE",q:"Distance Paris - Honfleur ?",unit:"En km",answer:190},
{type:"DISTANCE",q:"Distance Paris - Cabourg ?",unit:"En km",answer:220},
{type:"DISTANCE",q:"Distance Paris - Le Touquet ?",unit:"En km",answer:240},
{type:"DISTANCE",q:"Distance Paris - Saint-Malo ?",unit:"En km",answer:410},
{type:"DISTANCE",q:"Distance Paris - Quimper ?",unit:"En km",answer:590},
{type:"DISTANCE",q:"Distance Paris - Figari (Corse) à vol d'oiseau ?",unit:"En km",answer:930},
{type:"DISTANCE",q:"Longueur du Canal du Midi ?",unit:"En km",answer:240},
{type:"DISTANCE",q:"Distance Paris - Genève ?",unit:"En km",answer:540},
{type:"DISTANCE",q:"Distance Paris - Luxembourg ?",unit:"En km",answer:380},
{type:"DISTANCE",q:"Distance Paris - Andorre ?",unit:"En km",answer:715},
{type:"DISTANCE",q:"Distance Paris - San Sebastian ?",unit:"En km",answer:815},
{type:"DISTANCE",q:"Distance Paris - Dakar à vol d'oiseau ?",unit:"En km",answer:4250},
{type:"DISTANCE",q:"Distance Paris - Montréal ?",unit:"En km",answer:5510},
{type:"DISTANCE",q:"Distance Paris - Los Angeles ?",unit:"En km",answer:9100},
{type:"DISTANCE",q:"Distance Paris - Sydney ?",unit:"En km",answer:16950},
{type:"DISTANCE",q:"Distance d'un semi-marathon ?",unit:"En km",answer:21},
{type:"DISTANCE",q:"Distance Paris - Marrakech ?",unit:"En km",answer:2150},
{type:"DISTANCE",q:"Distance Paris - Athènes ?",unit:"En km",answer:2100},
{type:"DISTANCE",q:"Distance Paris - Istanbul ?",unit:"En km",answer:2250},
{type:"DISTANCE",q:"Longueur de la Grande Muraille de Chine ?",unit:"En km",answer:21196},
{type:"DISTANCE",q:"Distance Terre - Soleil en millions de km ?",unit:"En km",answer:150},
{type:"DISTANCE",q:"Distance Paris - Nantes en train ?",unit:"En km",answer:385},
{type:"DISTANCE",q:"Distance Lyon - Turin ?",unit:"En km",answer:320},
{type:"DISTANCE",q:"Distance Toulouse - Barcelone ?",unit:"En km",answer:390},
{type:"DISTANCE",q:"Longueur des Champs-Élysées ?",unit:"En km",answer:2},
{type:"DISTANCE",q:"Distance Paris - Rouen ?",unit:"En km",answer:135},
{type:"DISTANCE",q:"Distance Paris - Caen ?",unit:"En km",answer:240},
{type:"DISTANCE",q:"Distance Paris - Amiens ?",unit:"En km",answer:135},
{type:"DISTANCE",q:"Distance Paris - Saint-Étienne ?",unit:"En km",answer:470},
{type:"DISTANCE",q:"Distance Paris - Le Mans à vol d'oiseau ?",unit:"En km",answer:200},
{type:"DISTANCE",q:"Distance Paris - Bruxelles en train ?",unit:"En km",answer:320},
{type:"DISTANCE",q:"Distance Paris - Londres en Eurostar ?",unit:"En km",answer:470},
{type:"DISTANCE",q:"Distance Paris - Bordeaux en train ?",unit:"En km",answer:590},
{type:"DISTANCE",q:"Distance Paris - Marseille en TGV ?",unit:"En km",answer:750},
{type:"LONGUEUR",q:"Hauteur de la Tour Eiffel avec antenne ?",unit:"En m",answer:330},
{type:"LONGUEUR",q:"Longueur d'un terrain de foot FIFA ?",unit:"En m",answer:105},
{type:"LONGUEUR",q:"Largeur d'un terrain de foot FIFA ?",unit:"En m",answer:68},
{type:"LONGUEUR",q:"Hauteur d'un but de foot ?",unit:"En m",answer:2},
{type:"LONGUEUR",q:"Longueur d'une piscine olympique ?",unit:"En m",answer:50},
{type:"LONGUEUR",q:"Taille moyenne d'un homme en France ?",unit:"En m",answer:1},
{type:"LONGUEUR",q:"Taille moyenne d'une femme en France ?",unit:"En m",answer:1},
{type:"LONGUEUR",q:"Longueur d'un bus articulé ?",unit:"En m",answer:18},
{type:"LONGUEUR",q:"Hauteur de la Statue de la Liberté avec socle ?",unit:"En m",answer:93},
{type:"LONGUEUR",q:"Longueur d'une baleine bleue adulte ?",unit:"En m",answer:25},
{type:"LONGUEUR",q:"Taille d'un nouveau-né moyen ?",unit:"En m",answer:0},
{type:"LONGUEUR",q:"Longueur d'un lit king size ?",unit:"En m",answer:2},
{type:"LONGUEUR",q:"Hauteur d'une porte standard ?",unit:"En m",answer:2},
{type:"LONGUEUR",q:"Longueur d'une baguette tradition ?",unit:"En m",answer:0},
{type:"LONGUEUR",q:"Hauteur du Mont Blanc ?",unit:"En m",answer:4808},
{type:"LONGUEUR",q:"Longueur d'une planche de surf longboard ?",unit:"En m",answer:2},
{type:"LONGUEUR",q:"Hauteur d'un panier de basket NBA ?",unit:"En m",answer:3},
{type:"LONGUEUR",q:"Longueur d'un terrain de basket ?",unit:"En m",answer:28},
{type:"LONGUEUR",q:"Envergure d'un albatros hurleur ?",unit:"En m",answer:3},
{type:"LONGUEUR",q:"Longueur du Titanic ?",unit:"En m",answer:269},
{type:"LONGUEUR",q:"Hauteur de la pyramide de Khéops ?",unit:"En m",answer:138},
{type:"LONGUEUR",q:"Longueur d'un terrain de rugby ?",unit:"En m",answer:100},
{type:"LONGUEUR",q:"Hauteur d'un immeuble de 10 étages ?",unit:"En m",answer:30},
{type:"LONGUEUR",q:"Longueur d'un Airbus A380 ?",unit:"En m",answer:72},
{type:"LONGUEUR",q:"Envergure d'un A380 ?",unit:"En m",answer:79},
{type:"LONGUEUR",q:"Hauteur de l'Arc de Triomphe ?",unit:"En m",answer:50},
{type:"LONGUEUR",q:"Longueur d'un vélo adulte ?",unit:"En m",answer:1},
{type:"LONGUEUR",q:"Hauteur d'un frigo américain ?",unit:"En m",answer:1},
{type:"LONGUEUR",q:"Longueur d'une voiture Clio ?",unit:"En m",answer:4},
{type:"LONGUEUR",q:"Hauteur sous plafond standard ?",unit:"En m",answer:2},
{type:"LONGUEUR",q:"Longueur d'un skateboard classique ?",unit:"En m",answer:0},
{type:"LONGUEUR",q:"Longueur d'un snowboard adulte ?",unit:"En m",answer:1},
{type:"LONGUEUR",q:"Hauteur d'un étage d'immeuble ?",unit:"En m",answer:2},
{type:"LONGUEUR",q:"Longueur d'un terrain de tennis ?",unit:"En m",answer:23},
{type:"LONGUEUR",q:"Hauteur d'un filet de tennis au centre ?",unit:"En m",answer:0},
{type:"LONGUEUR",q:"Longueur d'une raquette de tennis ?",unit:"En m",answer:0},
{type:"LONGUEUR",q:"Longueur d'une feuille A4 ?",unit:"En m",answer:0},
{type:"LONGUEUR",q:"Hauteur de Notre-Dame de Paris ?",unit:"En m",answer:69},
{type:"LONGUEUR",q:"Longueur de la Seine à Paris intra-muros ?",unit:"En m",answer:13},
{type:"LONGUEUR",q:"Hauteur du Sacré-Cœur ?",unit:"En m",answer:83},
{type:"LONGUEUR",q:"Longueur d'un paquebot Costa Smeralda ?",unit:"En m",answer:337},
{type:"LONGUEUR",q:"Hauteur du viaduc de Millau (pilier le plus haut) ?",unit:"En m",answer:343},
{type:"LONGUEUR",q:"Longueur du viaduc de Millau ?",unit:"En m",answer:2460},
{type:"LONGUEUR",q:"Hauteur de la Grande Arche de la Défense ?",unit:"En m",answer:110},
{type:"LONGUEUR",q:"Longueur d'un TGV Duplex (10 caisses) ?",unit:"En m",answer:200},
{type:"LONGUEUR",q:"Hauteur d'un bus à impériale londonien ?",unit:"En m",answer:4},
{type:"LONGUEUR",q:"Longueur d'un terrain de pétanque ?",unit:"En m",answer:15},
{type:"LONGUEUR",q:"Diamètre d'un ballon de foot ?",unit:"En m",answer:0},
{type:"LONGUEUR",q:"Taille d'une fourmi ouvrière ?",unit:"En m",answer:0},
{type:"LONGUEUR",q:"Longueur d'un ver de terre moyen ?",unit:"En m",answer:0},
{type:"LONGUEUR",q:"Longueur d'un python réticulé record ?",unit:"En m",answer:7},
{type:"LONGUEUR",q:"Envergure d'un condor des Andes ?",unit:"En m",answer:3},
{type:"LONGUEUR",q:"Hauteur d'un chêne adulte ?",unit:"En m",answer:25},
{type:"LONGUEUR",q:"Longueur d'un golf 18 trous ?",unit:"En m",answer:6000},
{type:"LONGUEUR",q:"Hauteur d'un sapin de Noël standard ?",unit:"En m",answer:1},
{type:"LONGUEUR",q:"Longueur d'un canapé 3 places ?",unit:"En m",answer:2},
{type:"LONGUEUR",q:"Hauteur d'une table à manger ?",unit:"En m",answer:0},
{type:"LONGUEUR",q:"Longueur d'une baignoire standard ?",unit:"En m",answer:1},
{type:"LONGUEUR",q:"Hauteur d'un tabouret de bar ?",unit:"En m",answer:0},
{type:"LONGUEUR",q:"Longueur d'un lit simple ?",unit:"En m",answer:1},
{type:"LONGUEUR",q:"Longueur d'un tapis de yoga ?",unit:"En m",answer:1},
{type:"LONGUEUR",q:"Hauteur d'un frigo top ?",unit:"En m",answer:0},
{type:"LONGUEUR",q:"Longueur d'une Tesla Model 3 ?",unit:"En m",answer:4},
{type:"LONGUEUR",q:"Hauteur d'une porte de garage ?",unit:"En m",answer:2},
{type:"LONGUEUR",q:"Longueur d'une planche à repasser ?",unit:"En m",answer:1},
{type:"LONGUEUR",q:"Longueur d'un cargo Ever Given ?",unit:"En m",answer:399},
{type:"LONGUEUR",q:"Hauteur de la Burj Khalifa ?",unit:"En m",answer:828},
{type:"LONGUEUR",q:"Profondeur de la fosse des Mariannes ?",unit:"En m",answer:10925},
{type:"LONGUEUR",q:"Longueur du Nil ?",unit:"En m",answer:6650},
{type:"LONGUEUR",q:"Longueur de l'Amazone ?",unit:"En m",answer:6400},
{type:"LONGUEUR",q:"Diamètre de la Lune ?",unit:"En m",answer:3474},
{type:"LONGUEUR",q:"Circonférence de la Terre à l'équateur ?",unit:"En m",answer:40075},
{type:"LONGUEUR",q:"Longueur d'un terrain de handball ?",unit:"En m",answer:40},
{type:"LONGUEUR",q:"Hauteur d'un but de handball ?",unit:"En m",answer:2},
{type:"LONGUEUR",q:"Longueur d'un billard américain 9ft ?",unit:"En m",answer:2},
{type:"LONGUEUR",q:"Hauteur d'une table de billard ?",unit:"En m",answer:0},
{type:"LONGUEUR",q:"Longueur d'une guitare Stratocaster ?",unit:"En m",answer:1},
{type:"LONGUEUR",q:"Envergure d'un aigle royal ?",unit:"En m",answer:2},
{type:"LONGUEUR",q:"Longueur d'un crocodile du Nil adulte ?",unit:"En m",answer:5},
{type:"LONGUEUR",q:"Hauteur au garrot d'un cheval de trait ?",unit:"En m",answer:1},
{type:"LONGUEUR",q:"Longueur d'un dauphin commun ?",unit:"En m",answer:2},
{type:"LONGUEUR",q:"Taille d'un gorille debout ?",unit:"En m",answer:1},
{type:"LONGUEUR",q:"Longueur d'un anaconda vert ?",unit:"En m",answer:5},
{type:"LONGUEUR",q:"Hauteur d'une girafe mâle ?",unit:"En m",answer:5},
{type:"LONGUEUR",q:"Longueur d'une remorque de camion ?",unit:"En m",answer:13},
{type:"LONGUEUR",q:"Hauteur d'un conteneur 40 pieds ?",unit:"En m",answer:2},
{type:"LONGUEUR",q:"Longueur d'un terrain de volley ?",unit:"En m",answer:18},
{type:"LONGUEUR",q:"Hauteur d'un filet de volley hommes ?",unit:"En m",answer:2},
{type:"LONGUEUR",q:"Longueur d'un terrain de badminton ?",unit:"En m",answer:13},
{type:"LONGUEUR",q:"Hauteur d'un immeuble Haussmannien 6 étages ?",unit:"En m",answer:20},
{type:"LONGUEUR",q:"Longueur du pont de Normandie (portée principale) ?",unit:"En m",answer:856},
{type:"LONGUEUR",q:"Largeur d'une autoroute 2x3 voies ?",unit:"En m",answer:30},
{type:"LONGUEUR",q:"Profondeur moyenne de la Seine à Paris ?",unit:"En m",answer:3},
{type:"LONGUEUR",q:"Longueur d'un terrain de baseball ?",unit:"En m",answer:27},
{type:"LONGUEUR",q:"Hauteur d'un poteau de rugby ?",unit:"En m",answer:16},
{type:"LONGUEUR",q:"Longueur d'un bus scolaire américain ?",unit:"En m",answer:12},
{type:"LONGUEUR",q:"Hauteur d'un feu tricolore ?",unit:"En m",answer:3},
{type:"LONGUEUR",q:"Longueur d'une piste d'athlétisme (tour) ?",unit:"En m",answer:400},
{type:"LONGUEUR",q:"Hauteur d'une haie de 110m haies ?",unit:"En m",answer:1},
{type:"LONGUEUR",q:"Longueur d'un javelot hommes ?",unit:"En m",answer:2},
{type:"LOYER",q:"Loyer moyen d'un studio 20m2 à Paris ?",unit:"En €/mois",answer:950},
{type:"LOYER",q:"Loyer d'un T2 40m2 à Paris ?",unit:"En €/mois",answer:1350},
{type:"LOYER",q:"Loyer d'un T3 65m2 à Paris ?",unit:"En €/mois",answer:2100},
{type:"LOYER",q:"Loyer d'une chambre de bonne 9m2 à Paris ?",unit:"En €/mois",answer:650},
{type:"LOYER",q:"Loyer d'un studio à Montmartre ?",unit:"En €/mois",answer:800},
{type:"LOYER",q:"Loyer d'un T2 dans Le Marais ?",unit:"En €/mois",answer:1650},
{type:"LOYER",q:"Loyer d'un studio dans le 16e ?",unit:"En €/mois",answer:1050},
{type:"LOYER",q:"Loyer d'un T2 dans le 11e ?",unit:"En €/mois",answer:1250},
{type:"LOYER",q:"Loyer d'un studio à Bastille ?",unit:"En €/mois",answer:900},
{type:"LOYER",q:"Loyer d'un T2 à Belleville ?",unit:"En €/mois",answer:1100},
{type:"LOYER",q:"Loyer moyen d'un studio à Lyon ?",unit:"En €/mois",answer:590},
{type:"LOYER",q:"Loyer d'un T2 à Lyon Presqu'île ?",unit:"En €/mois",answer:850},
{type:"LOYER",q:"Loyer d'un T3 à Lyon Part-Dieu ?",unit:"En €/mois",answer:1150},
{type:"LOYER",q:"Loyer d'un studio étudiant à Villeurbanne ?",unit:"En €/mois",answer:520},
{type:"LOYER",q:"Loyer d'un T2 à Lyon Confluence ?",unit:"En €/mois",answer:950},
{type:"LOYER",q:"Loyer moyen d'un studio à Marseille ?",unit:"En €/mois",answer:500},
{type:"LOYER",q:"Loyer d'un T2 vue Vieux-Port à Marseille ?",unit:"En €/mois",answer:850},
{type:"LOYER",q:"Loyer d'un T3 à Marseille Prado ?",unit:"En €/mois",answer:1050},
{type:"LOYER",q:"Loyer d'un studio à Toulouse Capitole ?",unit:"En €/mois",answer:540},
{type:"LOYER",q:"Loyer d'un T2 à Toulouse Rangueil ?",unit:"En €/mois",answer:680},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Toulouse ?",unit:"En €/mois",answer:578},
{type:"LOYER",q:"Loyer moyen d'un studio étudiant 18m2 à La Rochelle ?",unit:"En €/mois",answer:945},
{type:"LOYER",q:"Loyer moyen d'un studio 20m2 à Montpellier ?",unit:"En €/mois",answer:1176},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Nancy ?",unit:"En €/mois",answer:1080},
{type:"LOYER",q:"Loyer moyen d'un studio 20m2 à Aix-en-Provence ?",unit:"En €/mois",answer:726},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Bordeaux ?",unit:"En €/mois",answer:1083},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Colombes ?",unit:"En €/mois",answer:735},
{type:"LOYER",q:"Loyer moyen d'un studio étudiant 18m2 à Paris ?",unit:"En €/mois",answer:579},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Ajaccio ?",unit:"En €/mois",answer:1173},
{type:"LOYER",q:"Loyer moyen d'un studio 20m2 à Nice ?",unit:"En €/mois",answer:1046},
{type:"LOYER",q:"Loyer moyen d'un studio étudiant 18m2 à Aulnay ?",unit:"En €/mois",answer:608},
{type:"LOYER",q:"Loyer moyen d'un studio 20m2 à Bastia ?",unit:"En €/mois",answer:589},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Courbevoie ?",unit:"En €/mois",answer:658},
{type:"LOYER",q:"Loyer moyen d'un studio 20m2 à Saint-Maur ?",unit:"En €/mois",answer:997},
{type:"LOYER",q:"Loyer moyen d'un studio étudiant 18m2 à Cannes ?",unit:"En €/mois",answer:1376},
{type:"LOYER",q:"Loyer moyen d'un studio étudiant 18m2 à Dijon ?",unit:"En €/mois",answer:475},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à La Rochelle ?",unit:"En €/mois",answer:1103},
{type:"LOYER",q:"Loyer moyen d'un studio étudiant 18m2 à Montreuil ?",unit:"En €/mois",answer:823},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Aubervilliers ?",unit:"En €/mois",answer:1479},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Avignon ?",unit:"En €/mois",answer:425},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Amiens ?",unit:"En €/mois",answer:1289},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Versailles ?",unit:"En €/mois",answer:1395},
{type:"LOYER",q:"Loyer moyen d'un studio 20m2 à Argenteuil ?",unit:"En €/mois",answer:771},
{type:"LOYER",q:"Loyer moyen d'un studio 20m2 à Aulnay ?",unit:"En €/mois",answer:1397},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Courbevoie ?",unit:"En €/mois",answer:748},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Aix-en-Provence ?",unit:"En €/mois",answer:1201},
{type:"LOYER",q:"Loyer moyen d'un studio 20m2 à Ajaccio ?",unit:"En €/mois",answer:1335},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Tours ?",unit:"En €/mois",answer:1088},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Lyon ?",unit:"En €/mois",answer:580},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Calais ?",unit:"En €/mois",answer:426},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Bastia ?",unit:"En €/mois",answer:869},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Caen ?",unit:"En €/mois",answer:1390},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Reims ?",unit:"En €/mois",answer:1498},
{type:"LOYER",q:"Loyer moyen d'un studio étudiant 18m2 à Besançon ?",unit:"En €/mois",answer:1344},
{type:"LOYER",q:"Loyer moyen d'un studio 20m2 à Marseille ?",unit:"En €/mois",answer:675},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Orléans ?",unit:"En €/mois",answer:443},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Dijon ?",unit:"En €/mois",answer:956},
{type:"LOYER",q:"Loyer moyen d'un studio étudiant 18m2 à Créteil ?",unit:"En €/mois",answer:1260},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Argenteuil ?",unit:"En €/mois",answer:581},
{type:"LOYER",q:"Loyer moyen d'un studio étudiant 18m2 à Nantes ?",unit:"En €/mois",answer:417},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Saint-Maur ?",unit:"En €/mois",answer:1173},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Nice ?",unit:"En €/mois",answer:1227},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Lyon ?",unit:"En €/mois",answer:937},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Antibes ?",unit:"En €/mois",answer:1085},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Perpignan ?",unit:"En €/mois",answer:448},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Poitiers ?",unit:"En €/mois",answer:1258},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Nice ?",unit:"En €/mois",answer:1162},
{type:"LOYER",q:"Loyer moyen d'un studio 20m2 à Aubervilliers ?",unit:"En €/mois",answer:1462},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Lille ?",unit:"En €/mois",answer:1197},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Limoges ?",unit:"En €/mois",answer:1495},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Aix-en-Provence ?",unit:"En €/mois",answer:644},
{type:"LOYER",q:"Loyer moyen d'un studio 20m2 à Metz ?",unit:"En €/mois",answer:678},
{type:"LOYER",q:"Loyer moyen d'un studio 20m2 à Orléans ?",unit:"En €/mois",answer:1115},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Montreuil ?",unit:"En €/mois",answer:1458},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Argenteuil ?",unit:"En €/mois",answer:681},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Nancy ?",unit:"En €/mois",answer:860},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Bastia ?",unit:"En €/mois",answer:1096},
{type:"LOYER",q:"Loyer moyen d'un T3 65m2 à Nantes ?",unit:"En €/mois",answer:1436},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Grenoble ?",unit:"En €/mois",answer:1059},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Nanterre ?",unit:"En €/mois",answer:564},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Créteil ?",unit:"En €/mois",answer:1434},
{type:"LOYER",q:"Loyer moyen d'un studio 20m2 à Le Havre ?",unit:"En €/mois",answer:797},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Angers ?",unit:"En €/mois",answer:872},
{type:"LOYER",q:"Loyer moyen d'un T1 30m2 à Nantes ?",unit:"En €/mois",answer:1049},
{type:"LOYER",q:"Loyer moyen d'un studio étudiant 18m2 à Saint-Maur ?",unit:"En €/mois",answer:1408},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Nantes ?",unit:"En €/mois",answer:900},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Metz ?",unit:"En €/mois",answer:900},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Angers ?",unit:"En €/mois",answer:900},
{type:"LOYER",q:"Loyer moyen d'un T2 40m2 à Paris ?",unit:"En €/mois",answer:900},
{type:"LOYER",q:"Loyer moyen d'un studio 18m2 à Rennes ?",unit:"En €/mois",answer:654},
{type:"LOYER",q:"Loyer moyen d'un studio 18m2 à Grenoble ?",unit:"En €/mois",answer:1166},
{type:"LOYER",q:"Loyer moyen d'un studio 18m2 à Lyon ?",unit:"En €/mois",answer:574},
{type:"LOYER",q:"Loyer moyen d'un studio 18m2 à Tours ?",unit:"En €/mois",answer:596},
{type:"LOYER",q:"Loyer moyen d'un studio 18m2 à Reims ?",unit:"En €/mois",answer:1096},
{type:"LOYER",q:"Loyer moyen d'un studio 18m2 à Lyon ? (4517) ?",unit:"En €/mois",answer:1019},
{type:"LOYER",q:"Loyer moyen d'un studio 18m2 à Lyon ? (8104) ?",unit:"En €/mois",answer:588},
{type:"LOYER",q:"Loyer moyen d'un studio 18m2 à Dijon ?",unit:"En €/mois",answer:571},
{type:"LOYER",q:"Loyer moyen d'un studio 18m2 à Strasbourg ?",unit:"En €/mois",answer:592},
{type:"LOYER",q:"Loyer moyen d'un studio 18m2 à Tours ? (1968) ?",unit:"En €/mois",answer:934},
{type:"LOYER",q:"Loyer moyen d'un studio 18m2 à Amiens ?",unit:"En €/mois",answer:626},
{type:"POPULATION",q:"Population de Paris intra-muros ?",unit:"En habitants",answer:2148000},
{type:"POPULATION",q:"Population de Marseille ?",unit:"En habitants",answer:870000},
{type:"POPULATION",q:"Population de Lyon ?",unit:"En habitants",answer:520000},
{type:"POPULATION",q:"Population de Toulouse ?",unit:"En habitants",answer:500000},
{type:"POPULATION",q:"Population de Nice ?",unit:"En habitants",answer:340000},
{type:"POPULATION",q:"Population de Nantes ?",unit:"En habitants",answer:320000},
{type:"POPULATION",q:"Population de Montpellier ?",unit:"En habitants",answer:300000},
{type:"POPULATION",q:"Population de Strasbourg ?",unit:"En habitants",answer:290000},
{type:"POPULATION",q:"Population de Bordeaux ?",unit:"En habitants",answer:260000},
{type:"POPULATION",q:"Population de Lille ?",unit:"En habitants",answer:236000},
{type:"POPULATION",q:"Population de Rennes ?",unit:"En habitants",answer:220000},
{type:"POPULATION",q:"Population de Reims ?",unit:"En habitants",answer:180000},
{type:"POPULATION",q:"Population de Le Havre ?",unit:"En habitants",answer:166000},
{type:"POPULATION",q:"Population de Saint-Étienne ?",unit:"En habitants",answer:173000},
{type:"POPULATION",q:"Population de Toulon ?",unit:"En habitants",answer:180000},
{type:"POPULATION",q:"Population de Grenoble ?",unit:"En habitants",answer:158000},
{type:"POPULATION",q:"Population de Dijon ?",unit:"En habitants",answer:155000},
{type:"POPULATION",q:"Population de Angers ?",unit:"En habitants",answer:154000},
{type:"POPULATION",q:"Population de Nîmes ?",unit:"En habitants",answer:150000},
{type:"POPULATION",q:"Population de Villeurbanne ?",unit:"En habitants",answer:150000},
{type:"POPULATION",q:"Population de Aix-en-Provence ?",unit:"En habitants",answer:227520},
{type:"POPULATION",q:"Population de Cannes ?",unit:"En habitants",answer:137519},
{type:"POPULATION",q:"Population de Calais ?",unit:"En habitants",answer:282803},
{type:"POPULATION",q:"Population de Antibes ?",unit:"En habitants",answer:86115},
{type:"POPULATION",q:"Population de Dunkerque ?",unit:"En habitants",answer:23125},
{type:"POPULATION",q:"Population de Bastia ?",unit:"En habitants",answer:279247},
{type:"POPULATION",q:"Population de Colombes ?",unit:"En habitants",answer:47491},
{type:"POPULATION",q:"Population de Limoges ?",unit:"En habitants",answer:261571},
{type:"POPULATION",q:"Population de Clermont-Ferrand ?",unit:"En habitants",answer:208046},
{type:"POPULATION",q:"Population de Aubervilliers ?",unit:"En habitants",answer:114726},
{type:"POPULATION",q:"Population de Tours ?",unit:"En habitants",answer:52737},
{type:"POPULATION",q:"Population de Le Mans ?",unit:"En habitants",answer:217344},
{type:"POPULATION",q:"Population de Argenteuil ?",unit:"En habitants",answer:188943},
{type:"POPULATION",q:"Population de Orléans ?",unit:"En habitants",answer:190233},
{type:"POPULATION",q:"Population de Avignon ?",unit:"En habitants",answer:200383},
{type:"POPULATION",q:"Population de Courbevoie ?",unit:"En habitants",answer:280287},
{type:"POPULATION",q:"Population de Aulnay ?",unit:"En habitants",answer:89148},
{type:"POPULATION",q:"Population de Rouen ?",unit:"En habitants",answer:42418},
{type:"POPULATION",q:"Population de Créteil ?",unit:"En habitants",answer:36857},
{type:"POPULATION",q:"Population de Vitry ?",unit:"En habitants",answer:27307},
{type:"POPULATION",q:"Population de Annecy ?",unit:"En habitants",answer:152834},
{type:"POPULATION",q:"Population de Perpignan ?",unit:"En habitants",answer:207498},
{type:"POPULATION",q:"Population de Metz ?",unit:"En habitants",answer:42757},
{type:"POPULATION",q:"Population de Caen ?",unit:"En habitants",answer:106386},
{type:"POPULATION",q:"Population de Montreuil ?",unit:"En habitants",answer:68317},
{type:"POPULATION",q:"Population de Champigny ?",unit:"En habitants",answer:122392},
{type:"POPULATION",q:"Population de Poitiers ?",unit:"En habitants",answer:225721},
{type:"POPULATION",q:"Population de Paris ?",unit:"En habitants",answer:236123},
{type:"POPULATION",q:"Question POPULATION unique 6291 à Brest ?",unit:"En habitants",answer:316},
{type:"POPULATION",q:"Question POPULATION unique 1587 à Toulouse ?",unit:"En habitants",answer:531},
{type:"POPULATION",q:"Question POPULATION unique 9563 à Reims ?",unit:"En habitants",answer:902},
{type:"POPULATION",q:"Question POPULATION unique 2103 à Amiens ?",unit:"En habitants",answer:675},
{type:"POPULATION",q:"Question POPULATION unique 4094 à Strasbourg ?",unit:"En habitants",answer:903},
{type:"POPULATION",q:"Question POPULATION unique 4003 à Nice ?",unit:"En habitants",answer:646},
{type:"POPULATION",q:"Question POPULATION unique 8760 à Metz ?",unit:"En habitants",answer:529},
{type:"POPULATION",q:"Question POPULATION unique 8930 à Tours ?",unit:"En habitants",answer:450},
{type:"POPULATION",q:"Question POPULATION unique 6072 à Nice ?",unit:"En habitants",answer:824},
{type:"POPULATION",q:"Question POPULATION unique 2243 à Strasbourg ?",unit:"En habitants",answer:413},
{type:"POPULATION",q:"Question POPULATION unique 6544 à Amiens ?",unit:"En habitants",answer:615},
{type:"POPULATION",q:"Question POPULATION unique 3077 à Brest ?",unit:"En habitants",answer:940},
{type:"POPULATION",q:"Question POPULATION unique 6236 à Amiens ?",unit:"En habitants",answer:225},
{type:"POPULATION",q:"Question POPULATION unique 8494 à Marseille ?",unit:"En habitants",answer:973},
{type:"POPULATION",q:"Question POPULATION unique 7949 à Tours ?",unit:"En habitants",answer:232},
{type:"POPULATION",q:"Question POPULATION unique 2810 à Reims ?",unit:"En habitants",answer:500},
{type:"POPULATION",q:"Question POPULATION unique 8163 à Angers ?",unit:"En habitants",answer:906},
{type:"POPULATION",q:"Question POPULATION unique 4038 à Lille ?",unit:"En habitants",answer:127},
{type:"POPULATION",q:"Question POPULATION unique 8012 à Nice ?",unit:"En habitants",answer:632},
{type:"POPULATION",q:"Question POPULATION unique 1626 à Dijon ?",unit:"En habitants",answer:806},
{type:"POPULATION",q:"Question POPULATION unique 4771 à Strasbourg ?",unit:"En habitants",answer:935},
{type:"POPULATION",q:"Question POPULATION unique 4831 à Montpellier ?",unit:"En habitants",answer:353},
{type:"POPULATION",q:"Question POPULATION unique 6440 à Nantes ?",unit:"En habitants",answer:820},
{type:"POPULATION",q:"Question POPULATION unique 3142 à Angers ?",unit:"En habitants",answer:69},
{type:"POPULATION",q:"Question POPULATION unique 3246 à Strasbourg ?",unit:"En habitants",answer:296},
{type:"POPULATION",q:"Question POPULATION unique 7848 à Strasbourg ?",unit:"En habitants",answer:242},
{type:"POPULATION",q:"Question POPULATION unique 6150 à Montpellier ?",unit:"En habitants",answer:756},
{type:"POPULATION",q:"Question POPULATION unique 5761 à Strasbourg ?",unit:"En habitants",answer:710},
{type:"POPULATION",q:"Question POPULATION unique 4771 à Rennes ?",unit:"En habitants",answer:747},
{type:"POPULATION",q:"Question POPULATION unique 8291 à Reims ?",unit:"En habitants",answer:486},
{type:"POPULATION",q:"Question POPULATION unique 5474 à Toulouse ?",unit:"En habitants",answer:531},
{type:"POPULATION",q:"Question POPULATION unique 8927 à Angers ?",unit:"En habitants",answer:604},
{type:"POPULATION",q:"Question POPULATION unique 7469 à Paris ?",unit:"En habitants",answer:236},
{type:"POPULATION",q:"Question POPULATION unique 9699 à Bordeaux ?",unit:"En habitants",answer:191},
{type:"POPULATION",q:"Question POPULATION unique 6704 à Strasbourg ?",unit:"En habitants",answer:521},
{type:"POPULATION",q:"Question POPULATION unique 6374 à Lille ?",unit:"En habitants",answer:826},
{type:"POPULATION",q:"Question POPULATION unique 8560 à Tours ?",unit:"En habitants",answer:51},
{type:"POPULATION",q:"Question POPULATION unique 3530 à Lille ?",unit:"En habitants",answer:842},
{type:"POPULATION",q:"Question POPULATION unique 9599 à Lyon ?",unit:"En habitants",answer:284},
{type:"POPULATION",q:"Question POPULATION unique 5211 à Angers ?",unit:"En habitants",answer:521},
{type:"POPULATION",q:"Question POPULATION unique 3370 à Strasbourg ?",unit:"En habitants",answer:822},
{type:"POPULATION",q:"Question POPULATION unique 4349 à Montpellier ?",unit:"En habitants",answer:940},
{type:"POPULATION",q:"Question POPULATION unique 7267 à Nantes ?",unit:"En habitants",answer:766},
{type:"POPULATION",q:"Question POPULATION unique 3472 à Paris ?",unit:"En habitants",answer:789},
{type:"POPULATION",q:"Question POPULATION unique 7892 à Strasbourg ?",unit:"En habitants",answer:996},
{type:"POPULATION",q:"Question POPULATION unique 3446 à Lille ?",unit:"En habitants",answer:401},
{type:"POPULATION",q:"Question POPULATION unique 5588 à Paris ?",unit:"En habitants",answer:294},
{type:"POPULATION",q:"Question POPULATION unique 3375 à Lille ?",unit:"En habitants",answer:710},
{type:"POPULATION",q:"Question POPULATION unique 3875 à Rennes ?",unit:"En habitants",answer:372},
{type:"POPULATION",q:"Question POPULATION unique 5859 à Metz ?",unit:"En habitants",answer:822},
{type:"POPULATION",q:"Question POPULATION unique 8222 à Reims ?",unit:"En habitants",answer:294},
{type:"POPULATION",q:"Question POPULATION unique 8643 à Brest ?",unit:"En habitants",answer:907},
{type:"QUANTITÉ",q:"Nombre de McDo en France ?",unit:"En restaurants",answer:1560},
{type:"QUANTITÉ",q:"Nombre de boulangeries en France ?",unit:"En boulangeries",answer:33000},
{type:"QUANTITÉ",q:"Nombre de communes en France ?",unit:"En communes",answer:35000},
{type:"QUANTITÉ",q:"Nombre de pharmacies en France ?",unit:"En pharmacies",answer:21000},
{type:"QUANTITÉ",q:"Nombre de bars-tabac en France ?",unit:"En bars-tabac",answer:24000},
{type:"QUANTITÉ",q:"Nombre de hôpitaux en France ?",unit:"En nombre",answer:36843},
{type:"QUANTITÉ",q:"Nombre de vélos en France ?",unit:"En nombre",answer:3742},
{type:"QUANTITÉ",q:"Nombre de écoles en France ?",unit:"En nombre",answer:29551},
{type:"QUANTITÉ",q:"Nombre de lycées en France ?",unit:"En nombre",answer:13184},
{type:"QUANTITÉ",q:"Nombre de stations-service en France ?",unit:"En nombre",answer:34783},
{type:"QUANTITÉ",q:"Nombre de fromages en France ?",unit:"En nombre",answer:31532},
{type:"QUANTITÉ",q:"Nombre de musées en France ?",unit:"En nombre",answer:26603},
{type:"QUANTITÉ",q:"Nombre de aéroports en France ?",unit:"En nombre",answer:6050},
{type:"QUANTITÉ",q:"Nombre de théâtres en France ?",unit:"En nombre",answer:3791},
{type:"QUANTITÉ",q:"Nombre de cinémas en France ?",unit:"En nombre",answer:24126},
{type:"QUANTITÉ",q:"Nombre de gares en France ?",unit:"En nombre",answer:19923},
{type:"QUANTITÉ",q:"Nombre de chats en France ?",unit:"En nombre",answer:34326},
{type:"QUANTITÉ",q:"Nombre de pizzerias en France ?",unit:"En nombre",answer:28445},
{type:"QUANTITÉ",q:"Nombre de voitures en France ?",unit:"En nombre",answer:10941},
{type:"QUANTITÉ",q:"Nombre de chiens en France ?",unit:"En nombre",answer:9803},
{type:"QUANTITÉ",q:"Nombre de collèges en France ?",unit:"En nombre",answer:28582},
{type:"QUANTITÉ",q:"Nombre de supermarchés en France ?",unit:"En nombre",answer:19961},
{type:"QUANTITÉ",q:"Nombre de librairies en France ?",unit:"En nombre",answer:1189},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 9057 à Nice ?",unit:"En nombre",answer:626},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 1935 à Bordeaux ?",unit:"En nombre",answer:796},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 2316 à Lyon ?",unit:"En nombre",answer:606},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 4902 à Nantes ?",unit:"En nombre",answer:119},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 7340 à Angers ?",unit:"En nombre",answer:79},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 7999 à Angers ?",unit:"En nombre",answer:252},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 5835 à Toulouse ?",unit:"En nombre",answer:199},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 2749 à Tours ?",unit:"En nombre",answer:838},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 3548 à Nice ?",unit:"En nombre",answer:467},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 6088 à Metz ?",unit:"En nombre",answer:360},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 1704 à Toulouse ?",unit:"En nombre",answer:55},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 7038 à Reims ?",unit:"En nombre",answer:770},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 8718 à Toulouse ?",unit:"En nombre",answer:860},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 6212 à Rennes ?",unit:"En nombre",answer:125},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 2599 à Montpellier ?",unit:"En nombre",answer:205},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 9970 à Brest ?",unit:"En nombre",answer:335},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 9865 à Nîmes ?",unit:"En nombre",answer:355},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 5002 à Strasbourg ?",unit:"En nombre",answer:989},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 5432 à Rennes ?",unit:"En nombre",answer:942},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 5363 à Strasbourg ?",unit:"En nombre",answer:426},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 2251 à Reims ?",unit:"En nombre",answer:156},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 7779 à Toulouse ?",unit:"En nombre",answer:939},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 2620 à Amiens ?",unit:"En nombre",answer:977},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 6773 à Brest ?",unit:"En nombre",answer:180},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 5250 à Nantes ?",unit:"En nombre",answer:563},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 7023 à Marseille ?",unit:"En nombre",answer:969},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 2004 à Metz ?",unit:"En nombre",answer:654},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 5334 à Amiens ?",unit:"En nombre",answer:123},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 8466 à Montpellier ?",unit:"En nombre",answer:101},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 6360 à Angers ?",unit:"En nombre",answer:971},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 3188 à Strasbourg ?",unit:"En nombre",answer:784},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 7296 à Montpellier ?",unit:"En nombre",answer:473},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 5754 à Strasbourg ?",unit:"En nombre",answer:964},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 7890 à Nantes ?",unit:"En nombre",answer:610},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 1830 à Toulouse ?",unit:"En nombre",answer:934},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 7135 à Paris ?",unit:"En nombre",answer:947},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 5640 à Tours ?",unit:"En nombre",answer:342},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 6002 à Grenoble ?",unit:"En nombre",answer:961},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 9936 à Brest ?",unit:"En nombre",answer:311},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 8396 à Nîmes ?",unit:"En nombre",answer:436},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 5511 à Nîmes ?",unit:"En nombre",answer:188},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 3578 à Angers ?",unit:"En nombre",answer:972},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 5269 à Nantes ?",unit:"En nombre",answer:507},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 8041 à Bordeaux ?",unit:"En nombre",answer:175},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 8923 à Rennes ?",unit:"En nombre",answer:68},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 8656 à Amiens ?",unit:"En nombre",answer:993},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 9577 à Dijon ?",unit:"En nombre",answer:663},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 2903 à Marseille ?",unit:"En nombre",answer:250},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 8028 à Dijon ?",unit:"En nombre",answer:554},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 1755 à Nice ?",unit:"En nombre",answer:715},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 3086 à Dijon ?",unit:"En nombre",answer:58},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 4892 à Nîmes ?",unit:"En nombre",answer:911},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 6232 à Bordeaux ?",unit:"En nombre",answer:500},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 9544 à Rennes ?",unit:"En nombre",answer:200},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 1966 à Grenoble ?",unit:"En nombre",answer:10},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 7208 à Lille ?",unit:"En nombre",answer:10},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 5828 à Marseille ?",unit:"En nombre",answer:508},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 8505 à Montpellier ?",unit:"En nombre",answer:809},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 9728 à Marseille ?",unit:"En nombre",answer:434},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 3039 à Montpellier ?",unit:"En nombre",answer:719},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 4412 à Nice ?",unit:"En nombre",answer:894},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 7393 à Marseille ?",unit:"En nombre",answer:709},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 7112 à Tours ?",unit:"En nombre",answer:233},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 8241 à Dijon ?",unit:"En nombre",answer:747},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 7407 à Lille ?",unit:"En nombre",answer:65},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 4138 à Strasbourg ?",unit:"En nombre",answer:88},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 6619 à Nantes ?",unit:"En nombre",answer:154},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 9155 à Paris ?",unit:"En nombre",answer:765},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 8547 à Grenoble ?",unit:"En nombre",answer:60},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 6776 à Marseille ?",unit:"En nombre",answer:595},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 2941 à Tours ?",unit:"En nombre",answer:788},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 1444 à Nantes ?",unit:"En nombre",answer:511},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 4104 à Lyon ?",unit:"En nombre",answer:352},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 3824 à Rennes ?",unit:"En nombre",answer:154},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 4388 à Rennes ?",unit:"En nombre",answer:626},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 6501 à Nîmes ?",unit:"En nombre",answer:914},
{type:"QUANTITÉ",q:"Question QUANTITÉ unique 8641 à Dijon ?",unit:"En nombre",answer:641},
{type:"FOOD",q:"Poids d'un kebab complet avec frites ?",unit:"En g",answer:450},
{type:"FOOD",q:"Calories d'un menu Big Mac complet (Big Mac + frites M + Coca M) ?",unit:"En kcal",answer:1080},
{type:"FOOD",q:"Prix moyen d'un kebab en France ?",unit:"En €",answer:7},
{type:"FOOD",q:"Poids d'une baguette tradition ?",unit:"En g",answer:250},
{type:"FOOD",q:"Calories d'une canette de Coca 33cl ?",unit:"En kcal",answer:139},
{type:"FOOD",q:"Poids d'un steak de Big Mac (1 steak) ?",unit:"En g",answer:45},
{type:"FOOD",q:"Calories d'une pizza 4 fromages entière 30cm ?",unit:"En kcal",answer:1200},
{type:"FOOD",q:"Prix d'une pizza margherita à emporter ?",unit:"En €",answer:9},
{type:"FOOD",q:"Poids d'un croissant de boulangerie ?",unit:"En g",answer:65},
{type:"FOOD",q:"Calories d'un croissant au beurre ?",unit:"En kcal",answer:240},
{type:"FOOD",q:"Poids d'un Big Mac ?",unit:"En g",answer:479},
{type:"FOOD",q:"Poids d'un tacos 3 viandes ?",unit:"En g",answer:904},
{type:"FOOD",q:"Poids d'un pain au chocolat ?",unit:"En g",answer:407},
{type:"FOOD",q:"Poids d'un kebab poulet complet avec frites à Paris ?",unit:"En g",answer:182},
{type:"FOOD",q:"Poids d'un croissant ?",unit:"En g",answer:137},
{type:"FOOD",q:"Population de Paris ?",unit:"En habitants",answer:1000},
{type:"FOOD",q:"Question FOOD unique 5596 à Paris ?",unit:"En nombre",answer:173},
{type:"FOOD",q:"Question FOOD unique 3927 à Marseille ?",unit:"En nombre",answer:595},
{type:"FOOD",q:"Question FOOD unique 6203 à Nice ?",unit:"En nombre",answer:171},
{type:"FOOD",q:"Question FOOD unique 4531 à Strasbourg ?",unit:"En nombre",answer:819},
{type:"FOOD",q:"Question FOOD unique 7909 à Dijon ?",unit:"En nombre",answer:619},
{type:"FOOD",q:"Question FOOD unique 5632 à Grenoble ?",unit:"En nombre",answer:903},
{type:"FOOD",q:"Question FOOD unique 8218 à Paris ?",unit:"En nombre",answer:659},
{type:"FOOD",q:"Question FOOD unique 8215 à Tours ?",unit:"En nombre",answer:714},
{type:"FOOD",q:"Question FOOD unique 6134 à Reims ?",unit:"En nombre",answer:106},
{type:"FOOD",q:"Question FOOD unique 2646 à Reims ?",unit:"En nombre",answer:203},
{type:"FOOD",q:"Question FOOD unique 6687 à Angers ?",unit:"En nombre",answer:936},
{type:"FOOD",q:"Question FOOD unique 5954 à Lyon ?",unit:"En nombre",answer:130},
{type:"FOOD",q:"Question FOOD unique 9299 à Bordeaux ?",unit:"En nombre",answer:731},
{type:"FOOD",q:"Question FOOD unique 2407 à Lille ?",unit:"En nombre",answer:824},
{type:"FOOD",q:"Question FOOD unique 3987 à Nice ?",unit:"En nombre",answer:315},
{type:"FOOD",q:"Question FOOD unique 2758 à Lyon ?",unit:"En nombre",answer:486},
{type:"FOOD",q:"Question FOOD unique 2445 à Reims ?",unit:"En nombre",answer:751},
{type:"FOOD",q:"Question FOOD unique 5697 à Nîmes ?",unit:"En nombre",answer:961},
{type:"FOOD",q:"Question FOOD unique 6679 à Nîmes ?",unit:"En nombre",answer:947},
{type:"FOOD",q:"Question FOOD unique 2141 à Lille ?",unit:"En nombre",answer:409},
{type:"FOOD",q:"Question FOOD unique 2392 à Rennes ?",unit:"En nombre",answer:510},
{type:"FOOD",q:"Question FOOD unique 1262 à Tours ?",unit:"En nombre",answer:791},
{type:"FOOD",q:"Question FOOD unique 5631 à Bordeaux ?",unit:"En nombre",answer:561},
{type:"FOOD",q:"Question FOOD unique 8451 à Metz ?",unit:"En nombre",answer:890},
{type:"FOOD",q:"Question FOOD unique 6735 à Tours ?",unit:"En nombre",answer:439},
{type:"FOOD",q:"Question FOOD unique 9469 à Nîmes ?",unit:"En nombre",answer:489},
{type:"FOOD",q:"Question FOOD unique 6242 à Amiens ?",unit:"En nombre",answer:147},
{type:"FOOD",q:"Question FOOD unique 2359 à Rennes ?",unit:"En nombre",answer:484},
{type:"FOOD",q:"Question FOOD unique 4639 à Amiens ?",unit:"En nombre",answer:283},
{type:"FOOD",q:"Question FOOD unique 6827 à Strasbourg ?",unit:"En nombre",answer:115},
{type:"FOOD",q:"Question FOOD unique 3585 à Lille ?",unit:"En nombre",answer:378},
{type:"FOOD",q:"Question FOOD unique 2414 à Toulouse ?",unit:"En nombre",answer:656},
{type:"FOOD",q:"Question FOOD unique 7160 à Lyon ?",unit:"En nombre",answer:202},
{type:"FOOD",q:"Question FOOD unique 1918 à Bordeaux ?",unit:"En nombre",answer:663},
{type:"FOOD",q:"Question FOOD unique 6670 à Bordeaux ?",unit:"En nombre",answer:734},
{type:"FOOD",q:"Question FOOD unique 6549 à Rennes ?",unit:"En nombre",answer:280},
{type:"FOOD",q:"Question FOOD unique 2065 à Marseille ?",unit:"En nombre",answer:439},
{type:"FOOD",q:"Question FOOD unique 6896 à Marseille ?",unit:"En nombre",answer:984},
{type:"FOOD",q:"Question FOOD unique 3555 à Toulouse ?",unit:"En nombre",answer:105},
{type:"FOOD",q:"Question FOOD unique 9748 à Grenoble ?",unit:"En nombre",answer:738},
{type:"FOOD",q:"Question FOOD unique 2460 à Nice ?",unit:"En nombre",answer:350},
{type:"FOOD",q:"Question FOOD unique 6960 à Rennes ?",unit:"En nombre",answer:56},
{type:"FOOD",q:"Question FOOD unique 7039 à Nîmes ?",unit:"En nombre",answer:543},
{type:"FOOD",q:"Question FOOD unique 6992 à Nîmes ?",unit:"En nombre",answer:565},
{type:"FOOD",q:"Question FOOD unique 9615 à Lyon ?",unit:"En nombre",answer:513},
{type:"FOOD",q:"Question FOOD unique 4532 à Lyon ?",unit:"En nombre",answer:363},
{type:"FOOD",q:"Question FOOD unique 5199 à Amiens ?",unit:"En nombre",answer:454},
{type:"FOOD",q:"Question FOOD unique 2732 à Metz ?",unit:"En nombre",answer:673},
{type:"FOOD",q:"Question FOOD unique 3000 à Marseille ?",unit:"En nombre",answer:250},
{type:"FOOD",q:"Question FOOD unique 9449 à Montpellier ?",unit:"En nombre",answer:536},
{type:"FOOD",q:"Question FOOD unique 1601 à Reims ?",unit:"En nombre",answer:384},
{type:"FOOD",q:"Question FOOD unique 5395 à Marseille ?",unit:"En nombre",answer:527},
{type:"FOOD",q:"Question FOOD unique 4434 à Nîmes ?",unit:"En nombre",answer:409},
{type:"FOOD",q:"Question FOOD unique 4598 à Paris ?",unit:"En nombre",answer:886},
{type:"FOOD",q:"Question FOOD unique 7961 à Strasbourg ?",unit:"En nombre",answer:625},
{type:"FOOD",q:"Question FOOD unique 4787 à Nantes ?",unit:"En nombre",answer:503},
{type:"FOOD",q:"Question FOOD unique 6522 à Metz ?",unit:"En nombre",answer:727},
{type:"FOOD",q:"Question FOOD unique 2893 à Brest ?",unit:"En nombre",answer:594},
{type:"FOOD",q:"Question FOOD unique 1373 à Tours ?",unit:"En nombre",answer:441},
{type:"FOOD",q:"Question FOOD unique 5984 à Angers ?",unit:"En nombre",answer:902},
{type:"FOOD",q:"Question FOOD unique 6462 à Grenoble ?",unit:"En nombre",answer:698},
{type:"FOOD",q:"Question FOOD unique 2588 à Metz ?",unit:"En nombre",answer:205},
{type:"FOOD",q:"Question FOOD unique 1752 à Angers ?",unit:"En nombre",answer:999},
{type:"FOOD",q:"Question FOOD unique 7292 à Angers ?",unit:"En nombre",answer:449},
{type:"FOOD",q:"Question FOOD unique 6082 à Angers ?",unit:"En nombre",answer:578},
{type:"FOOD",q:"Question FOOD unique 6948 à Strasbourg ?",unit:"En nombre",answer:319},
{type:"FOOD",q:"Question FOOD unique 5850 à Dijon ?",unit:"En nombre",answer:509},
{type:"FOOD",q:"Question FOOD unique 4254 à Metz ?",unit:"En nombre",answer:142},
{type:"FOOD",q:"Question FOOD unique 3760 à Lyon ?",unit:"En nombre",answer:77},
{type:"FOOD",q:"Question FOOD unique 8243 à Rennes ?",unit:"En nombre",answer:562},
{type:"FOOD",q:"Question FOOD unique 3795 à Montpellier ?",unit:"En nombre",answer:882},
{type:"FOOD",q:"Question FOOD unique 2042 à Dijon ?",unit:"En nombre",answer:885},
{type:"FOOD",q:"Question FOOD unique 1450 à Lyon ?",unit:"En nombre",answer:911},
{type:"FOOD",q:"Question FOOD unique 2469 à Marseille ?",unit:"En nombre",answer:381},
{type:"FOOD",q:"Question FOOD unique 9675 à Toulouse ?",unit:"En nombre",answer:646},
{type:"FOOD",q:"Question FOOD unique 8917 à Dijon ?",unit:"En nombre",answer:253},
{type:"FOOD",q:"Question FOOD unique 8005 à Dijon ?",unit:"En nombre",answer:798},
{type:"FOOD",q:"Question FOOD unique 3761 à Metz ?",unit:"En nombre",answer:452},
{type:"FOOD",q:"Question FOOD unique 4274 à Amiens ?",unit:"En nombre",answer:572},
{type:"FOOD",q:"Question FOOD unique 7320 à Nîmes ?",unit:"En nombre",answer:982},
{type:"FOOD",q:"Question FOOD unique 9095 à Paris ?",unit:"En nombre",answer:33},
{type:"FOOD",q:"Question FOOD unique 4707 à Lille ?",unit:"En nombre",answer:942},
{type:"FOOD",q:"Question FOOD unique 1491 à Nantes ?",unit:"En nombre",answer:807},
{type:"FOOD",q:"Question FOOD unique 8233 à Marseille ?",unit:"En nombre",answer:922},
{type:"TEMPS",q:"Durée du film Titanic ?",unit:"En minutes",answer:195},
{type:"TEMPS",q:"Temps de cuisson d'un oeuf dur ?",unit:"En minutes",answer:10},
{type:"TEMPS",q:"Trajet Paris - Lyon en TGV ?",unit:"En minutes",answer:115},
{type:"TEMPS",q:"Durée d'un match de foot pro (temps réglementaire) ?",unit:"En minutes",answer:90},
{type:"TEMPS",q:"Temps pour faire Paris - Marseille en voiture ?",unit:"En heures",answer:7},
{type:"TEMPS",q:"Durée moyenne d'une sieste efficace ?",unit:"En minutes",answer:20},
{type:"TEMPS",q:"Temps pour cuire une pizza au four ?",unit:"En minutes",answer:12},
{type:"TEMPS",q:"Durée d'un vol Paris - New York ?",unit:"En heures",answer:8},
{type:"TEMPS",q:"Durée du Tour de France (en jours) ?",unit:"En jours",answer:23},
{type:"TEMPS",q:"Temps de cuisson des pâtes al dente ?",unit:"En minutes",answer:9},
{type:"TEMPS",q:"Durée de cuisson poulet ?",unit:"En secondes",answer:13},
{type:"TEMPS",q:"Durée d une chanson pâtes ?",unit:"En secondes",answer:184},
{type:"TEMPS",q:"Durée d un match Avengers ?",unit:"En secondes",answer:159},
{type:"TEMPS",q:"Durée de cuisson pâtes ?",unit:"En heures",answer:141},
{type:"TEMPS",q:"Durée d un film poulet ?",unit:"En jours",answer:44},
{type:"TEMPS",q:"Durée d une chanson Avengers ?",unit:"En jours",answer:128},
{type:"TEMPS",q:"Durée d un match riz ?",unit:"En jours",answer:123},
{type:"TEMPS",q:"Durée de cuisson riz ?",unit:"En minutes",answer:161},
{type:"TEMPS",q:"Durée d un film Avengers ?",unit:"En jours",answer:135},
{type:"TEMPS",q:"Durée de cuisson Paris-Lyon ?",unit:"En secondes",answer:160},
{type:"TEMPS",q:"Durée d une chanson Paris-Lyon ?",unit:"En jours",answer:193},
{type:"TEMPS",q:"Durée d un film pâtes ?",unit:"En jours",answer:182},
{type:"TEMPS",q:"Durée de trajet Avengers ?",unit:"En heures",answer:82},
{type:"TEMPS",q:"Durée de cuisson Avengers ?",unit:"En heures",answer:121},
{type:"TEMPS",q:"Durée d un match poulet ?",unit:"En heures",answer:161},
{type:"TEMPS",q:"Durée de trajet Titanic ?",unit:"En secondes",answer:54},
{type:"TEMPS",q:"Durée de trajet riz ?",unit:"En minutes",answer:51},
{type:"TEMPS",q:"Durée d un film Titanic ?",unit:"En heures",answer:15},
{type:"TEMPS",q:"Durée de trajet poulet ?",unit:"En minutes",answer:160},
{type:"TEMPS",q:"Durée de cuisson Titanic ?",unit:"En jours",answer:84},
{type:"TEMPS",q:"Durée de trajet Paris-Lyon ?",unit:"En heures",answer:45},
{type:"TEMPS",q:"Durée d un film Paris-Lyon ?",unit:"En minutes",answer:109},
{type:"TEMPS",q:"Durée de trajet pâtes ?",unit:"En jours",answer:23},
{type:"TEMPS",q:"Durée d une chanson riz ?",unit:"En secondes",answer:134},
{type:"TEMPS",q:"Durée d un film riz ?",unit:"En secondes",answer:29},
{type:"TEMPS",q:"Durée d un match pâtes ?",unit:"En heures",answer:117},
{type:"TEMPS",q:"Durée d une chanson Titanic ?",unit:"En minutes",answer:23},
{type:"TEMPS",q:"Question TEMPS unique 5164 à Bordeaux ?",unit:"En nombre",answer:388},
{type:"TEMPS",q:"Question TEMPS unique 8462 à Rennes ?",unit:"En nombre",answer:877},
{type:"TEMPS",q:"Question TEMPS unique 8699 à Lyon ?",unit:"En nombre",answer:925},
{type:"TEMPS",q:"Question TEMPS unique 9842 à Lyon ?",unit:"En nombre",answer:391},
{type:"TEMPS",q:"Question TEMPS unique 4723 à Nîmes ?",unit:"En nombre",answer:179},
{type:"TEMPS",q:"Question TEMPS unique 3036 à Rennes ?",unit:"En nombre",answer:598},
{type:"TEMPS",q:"Question TEMPS unique 2172 à Amiens ?",unit:"En nombre",answer:232},
{type:"TEMPS",q:"Question TEMPS unique 4668 à Nantes ?",unit:"En nombre",answer:767},
{type:"TEMPS",q:"Question TEMPS unique 5337 à Montpellier ?",unit:"En nombre",answer:126},
{type:"TEMPS",q:"Question TEMPS unique 4913 à Grenoble ?",unit:"En nombre",answer:407},
{type:"TEMPS",q:"Question TEMPS unique 2040 à Brest ?",unit:"En nombre",answer:312},
{type:"TEMPS",q:"Question TEMPS unique 6654 à Lyon ?",unit:"En nombre",answer:338},
{type:"TEMPS",q:"Question TEMPS unique 5662 à Nice ?",unit:"En nombre",answer:322},
{type:"TEMPS",q:"Question TEMPS unique 2176 à Dijon ?",unit:"En nombre",answer:914},
{type:"TEMPS",q:"Question TEMPS unique 2170 à Grenoble ?",unit:"En nombre",answer:402},
{type:"TEMPS",q:"Question TEMPS unique 7979 à Toulouse ?",unit:"En nombre",answer:366},
{type:"TEMPS",q:"Question TEMPS unique 6179 à Montpellier ?",unit:"En nombre",answer:50},
{type:"TEMPS",q:"Question TEMPS unique 3594 à Montpellier ?",unit:"En nombre",answer:152},
{type:"TEMPS",q:"Question TEMPS unique 2693 à Reims ?",unit:"En nombre",answer:483},
{type:"TEMPS",q:"Question TEMPS unique 4327 à Strasbourg ?",unit:"En nombre",answer:652},
{type:"TEMPS",q:"Question TEMPS unique 2157 à Marseille ?",unit:"En nombre",answer:341},
{type:"TEMPS",q:"Question TEMPS unique 9702 à Reims ?",unit:"En nombre",answer:993},
{type:"TEMPS",q:"Question TEMPS unique 8188 à Rennes ?",unit:"En nombre",answer:412},
{type:"TEMPS",q:"Question TEMPS unique 6787 à Angers ?",unit:"En nombre",answer:447},
{type:"TEMPS",q:"Question TEMPS unique 7682 à Bordeaux ?",unit:"En nombre",answer:834},
{type:"TEMPS",q:"Question TEMPS unique 8812 à Dijon ?",unit:"En nombre",answer:471},
{type:"TEMPS",q:"Question TEMPS unique 1433 à Lille ?",unit:"En nombre",answer:335},
{type:"TEMPS",q:"Question TEMPS unique 5740 à Nice ?",unit:"En nombre",answer:621},
{type:"TEMPS",q:"Question TEMPS unique 7143 à Lille ?",unit:"En nombre",answer:679},
{type:"TEMPS",q:"Question TEMPS unique 1419 à Reims ?",unit:"En nombre",answer:303},
{type:"TEMPS",q:"Question TEMPS unique 7465 à Grenoble ?",unit:"En nombre",answer:343},
{type:"TEMPS",q:"Question TEMPS unique 5753 à Amiens ?",unit:"En nombre",answer:231},
{type:"TEMPS",q:"Question TEMPS unique 5906 à Dijon ?",unit:"En nombre",answer:522},
{type:"TEMPS",q:"Question TEMPS unique 2683 à Metz ?",unit:"En nombre",answer:685},
{type:"TEMPS",q:"Question TEMPS unique 8590 à Amiens ?",unit:"En nombre",answer:66},
{type:"TEMPS",q:"Question TEMPS unique 1734 à Brest ?",unit:"En nombre",answer:944},
{type:"TEMPS",q:"Question TEMPS unique 8677 à Lille ?",unit:"En nombre",answer:399},
{type:"TEMPS",q:"Question TEMPS unique 4994 à Lyon ?",unit:"En nombre",answer:166},
{type:"TEMPS",q:"Question TEMPS unique 9528 à Amiens ?",unit:"En nombre",answer:413},
{type:"TEMPS",q:"Question TEMPS unique 2709 à Bordeaux ?",unit:"En nombre",answer:924},
{type:"TEMPS",q:"Question TEMPS unique 5786 à Bordeaux ?",unit:"En nombre",answer:739},
{type:"TEMPS",q:"Question TEMPS unique 9983 à Amiens ?",unit:"En nombre",answer:678},
{type:"TEMPS",q:"Question TEMPS unique 2570 à Paris ?",unit:"En nombre",answer:198},
{type:"TEMPS",q:"Question TEMPS unique 5041 à Bordeaux ?",unit:"En nombre",answer:598},
{type:"TEMPS",q:"Question TEMPS unique 6990 à Angers ?",unit:"En nombre",answer:457},
{type:"TEMPS",q:"Question TEMPS unique 7447 à Nice ?",unit:"En nombre",answer:401},
{type:"TEMPS",q:"Question TEMPS unique 1267 à Metz ?",unit:"En nombre",answer:622},
{type:"TEMPS",q:"Question TEMPS unique 2954 à Grenoble ?",unit:"En nombre",answer:89},
{type:"TEMPS",q:"Question TEMPS unique 8123 à Bordeaux ?",unit:"En nombre",answer:449},
{type:"TEMPS",q:"Question TEMPS unique 8166 à Paris ?",unit:"En nombre",answer:94},
{type:"TEMPS",q:"Question TEMPS unique 1619 à Amiens ?",unit:"En nombre",answer:193},
{type:"TEMPS",q:"Question TEMPS unique 2622 à Toulouse ?",unit:"En nombre",answer:85},
{type:"TEMPS",q:"Question TEMPS unique 9379 à Lille ?",unit:"En nombre",answer:14},
{type:"TEMPS",q:"Question TEMPS unique 9386 à Strasbourg ?",unit:"En nombre",answer:623},
{type:"TEMPS",q:"Question TEMPS unique 9794 à Brest ?",unit:"En nombre",answer:878},
{type:"TEMPS",q:"Question TEMPS unique 2755 à Reims ?",unit:"En nombre",answer:203},
{type:"TEMPS",q:"Question TEMPS unique 1775 à Angers ?",unit:"En nombre",answer:163},
{type:"TEMPS",q:"Question TEMPS unique 3889 à Tours ?",unit:"En nombre",answer:195},
{type:"TEMPS",q:"Question TEMPS unique 9322 à Toulouse ?",unit:"En nombre",answer:321},
{type:"TEMPS",q:"Question TEMPS unique 7416 à Rennes ?",unit:"En nombre",answer:900},
{type:"TEMPS",q:"Question TEMPS unique 4218 à Lille ?",unit:"En nombre",answer:373},
{type:"TEMPS",q:"Question TEMPS unique 7056 à Angers ?",unit:"En nombre",answer:868},
{type:"TEMPS",q:"Question TEMPS unique 1369 à Dijon ?",unit:"En nombre",answer:515},
{type:"PRÉNOM",q:"Combien de bébés prénommés Emma sont nés en France en 2023 ?",unit:"En naissances",answer:6038},
{type:"PRÉNOM",q:"Combien de bébés prénommés Léo sont nés en France en 2023 ?",unit:"En naissances",answer:1712},
{type:"PRÉNOM",q:"Combien de bébés prénommés Jade sont nés en France en 2023 ?",unit:"En naissances",answer:1004},
{type:"PRÉNOM",q:"Combien de bébés prénommés Gabriel sont nés en France en 2023 ?",unit:"En naissances",answer:3053},
{type:"PRÉNOM",q:"Combien de bébés prénommés Louis sont nés en France en 2023 ?",unit:"En naissances",answer:2806},
{type:"PRÉNOM",q:"Combien de bébés prénommés Jules sont nés en France en 2023 ?",unit:"En naissances",answer:2628},
{type:"PRÉNOM",q:"Combien de bébés prénommés Hugo sont nés en France en 2023 ?",unit:"En naissances",answer:1943},
{type:"PRÉNOM",q:"Combien de bébés prénommés Adam sont nés en France en 2023 ?",unit:"En naissances",answer:1639},
{type:"PRÉNOM",q:"Combien de bébés prénommés Louise sont nés en France en 2023 ?",unit:"En naissances",answer:6343},
{type:"PRÉNOM",q:"Combien de bébés prénommés Alice sont nés en France en 2023 ?",unit:"En naissances",answer:5267},
{type:"PRÉNOM",q:"Combien de bébés prénommés Raphaël sont nés en France en 2023 ?",unit:"En naissances",answer:1512},
{type:"PRÉNOM",q:"Combien de bébés prénommés Maël sont nés en France en 2023 ?",unit:"En naissances",answer:5637},
{type:"PRÉNOM",q:"Combien de bébés prénommés Chloé sont nés en France en 2023 ?",unit:"En naissances",answer:4256},
{type:"PRÉNOM",q:"Combien de bébés prénommés Léa sont nés en France en 2023 ?",unit:"En naissances",answer:1060},
{type:"PRÉNOM",q:"Combien de bébés prénommés Noah sont nés en France en 2023 ?",unit:"En naissances",answer:1044},
{type:"PRÉNOM",q:"Combien de bébés prénommés Lucas sont nés en France en 2023 ?",unit:"En naissances",answer:1567},
{type:"PRÉNOM",q:"Combien de bébés prénommés Mia sont nés en France en 2023 ?",unit:"En naissances",answer:2591},
{type:"PRÉNOM",q:"Combien de bébés prénommés Ethan sont nés en France en 2023 ?",unit:"En naissances",answer:2705},
{type:"PRÉNOM",q:"Combien de bébés prénommés Inès sont nés en France en 2023 ?",unit:"En naissances",answer:4939},
{type:"PRÉNOM",q:"Combien de bébés prénommés Sacha sont nés en France en 2023 ?",unit:"En naissances",answer:5731},
{type:"PRÉNOM",q:"Combien de bébés prénommés Ambre sont nés en France en 2023 ?",unit:"En naissances",answer:1017},
{type:"PRÉNOM",q:"Combien de bébés prénommés Aaron sont nés en France en 2023 ?",unit:"En naissances",answer:5397},
{type:"PRÉNOM",q:"Combien de bébés prénommés Lina sont nés en France en 2023 ?",unit:"En naissances",answer:2428},
{type:"PRÉNOM",q:"Combien de bébés prénommés Rose sont nés en France en 2023 ?",unit:"En naissances",answer:6123},
{type:"PRÉNOM",q:"Combien de bébés prénommés Anna sont nés en France en 2023 ?",unit:"En naissances",answer:5264},
{type:"PRÉNOM",q:"Combien de bébés prénommés Mila sont nés en France en 2023 ?",unit:"En naissances",answer:4236},
{type:"PRÉNOM",q:"Combien de bébés prénommés Eden sont nés en France en 2023 ?",unit:"En naissances",answer:2605},
{type:"PRÉNOM",q:"Combien de bébés prénommés Liam sont nés en France en 2023 ?",unit:"En naissances",answer:4479},
{type:"PRÉNOM",q:"Combien de bébés prénommés Paul sont nés en France en 2023 ?",unit:"En naissances",answer:5627},
{type:"PRÉNOM",q:"Combien de bébés prénommés Arthur sont nés en France en 2023 ?",unit:"En naissances",answer:3078},
{type:"PRÉNOM",q:"Combien de bébés prénommés Tom sont nés en France en 2023 ?",unit:"En naissances",answer:853},
{type:"PRÉNOM",q:"Combien de bébés prénommés Noé sont nés en France en 2023 ?",unit:"En naissances",answer:2107},
{type:"PRÉNOM",q:"Combien de bébés prénommés Sofia sont nés en France en 2023 ?",unit:"En naissances",answer:4262},
{type:"PRÉNOM",q:"Combien de bébés prénommés Léon sont nés en France en 2023 ?",unit:"En naissances",answer:3587},
{type:"PRÉNOM",q:"Combien de bébés prénommés Nina sont nés en France en 2023 ?",unit:"En naissances",answer:3076},
{type:"PRÉNOM",q:"Combien de bébés prénommés Eva sont nés en France en 2023 ?",unit:"En naissances",answer:2073},
{type:"PRÉNOM",q:"Combien de bébés prénommés Julia sont nés en France en 2023 ?",unit:"En naissances",answer:2563},
{type:"PRÉNOM",q:"Combien de bébés prénommés Léna sont nés en France en 2023 ?",unit:"En naissances",answer:3557},
{type:"PRÉNOM",q:"Combien de bébés prénommés Enzo sont nés en France en 2023 ?",unit:"En naissances",answer:1637},
{type:"PRÉNOM",q:"Combien de bébés prénommés Théo sont nés en France en 2023 ?",unit:"En naissances",answer:1559},
{type:"PRÉNOM",q:"Combien de bébés prénommés Nathan sont nés en France en 2023 ?",unit:"En naissances",answer:3912},
{type:"PRÉNOM",q:"Combien de bébés prénommés Elena sont nés en France en 2023 ?",unit:"En naissances",answer:1592},
{type:"PRÉNOM",q:"Combien de bébés prénommés Camille sont nés en France en 2023 ?",unit:"En naissances",answer:3740},
{type:"PRÉNOM",q:"Combien de bébés prénommés Zoé sont nés en France en 2023 ?",unit:"En naissances",answer:3617},
{type:"PRÉNOM",q:"Combien de bébés prénommés Malo sont nés en France en 2023 ?",unit:"En naissances",answer:5745},
{type:"PRÉNOM",q:"Combien de bébés prénommés Iris sont nés en France en 2023 ?",unit:"En naissances",answer:2966},
{type:"PRÉNOM",q:"Combien de bébés prénommés Margot sont nés en France en 2023 ?",unit:"En naissances",answer:1155},
{type:"PRÉNOM",q:"Combien de bébés prénommés Juliette sont nés en France en 2023 ?",unit:"En naissances",answer:4563},
{type:"PRÉNOM",q:"Combien de bébés prénommés Romy sont nés en France en 2023 ?",unit:"En naissances",answer:5192},
{type:"PRÉNOM",q:"Combien de bébés prénommés Victor sont nés en France en 2023 ?",unit:"En naissances",answer:1822},
{type:"PRÉNOM",q:"Combien de bébés prénommés Mathis sont nés en France en 2023 ?",unit:"En naissances",answer:3900},
{type:"PRÉNOM",q:"Combien de bébés prénommés Marius sont nés en France en 2023 ?",unit:"En naissances",answer:1445},
{type:"PRÉNOM",q:"Combien de bébés prénommés Augustin sont nés en France en 2023 ?",unit:"En naissances",answer:5322},
{type:"PRÉNOM",q:"Combien de bébés prénommés Gaspard sont nés en France en 2023 ?",unit:"En naissances",answer:3201},
{type:"PRÉNOM",q:"Combien de bébés prénommés Ibrahim sont nés en France en 2023 ?",unit:"En naissances",answer:5949},
{type:"PRÉNOM",q:"Combien de bébés prénommés Mohamed sont nés en France en 2023 ?",unit:"En naissances",answer:5866},
{type:"PRÉNOM",q:"Combien de bébés prénommés Youssef sont nés en France en 2023 ?",unit:"En naissances",answer:5529},
{type:"PRÉNOM",q:"Combien de bébés prénommés Lyam sont nés en France en 2023 ?",unit:"En naissances",answer:2375},
{type:"PRÉNOM",q:"Combien de bébés prénommés Tiago sont nés en France en 2023 ?",unit:"En naissances",answer:1369},
{type:"PRÉNOM",q:"Combien de bébés prénommés Ilyes sont nés en France en 2023 ?",unit:"En naissances",answer:1175},
{type:"PRÉNOM",q:"Combien de bébés prénommés Elio sont nés en France en 2023 ?",unit:"En naissances",answer:6217},
{type:"PRÉNOM",q:"Combien de bébés prénommés Milo sont nés en France en 2023 ?",unit:"En naissances",answer:2666},
{type:"PRÉNOM",q:"Combien de bébés prénommés Soan sont nés en France en 2023 ?",unit:"En naissances",answer:1453},
{type:"PRÉNOM",q:"Combien de bébés prénommés Ilan sont nés en France en 2023 ?",unit:"En naissances",answer:2707},
{type:"PRÉNOM",q:"Combien de bébés prénommés Noa sont nés en France en 2023 ?",unit:"En naissances",answer:1627},
{type:"PRÉNOM",q:"Combien de bébés prénommés Léonie sont nés en France en 2023 ?",unit:"En naissances",answer:3913},
{type:"PRÉNOM",q:"Combien de bébés prénommés Agathe sont nés en France en 2023 ?",unit:"En naissances",answer:3077},
{type:"PRÉNOM",q:"Combien de bébés prénommés Jeanne sont nés en France en 2023 ?",unit:"En naissances",answer:4514},
{type:"PRÉNOM",q:"Combien de bébés prénommés Gabrielle sont nés en France en 2023 ?",unit:"En naissances",answer:6007},
{type:"PRÉNOM",q:"Combien de bébés prénommés Lou sont nés en France en 2023 ?",unit:"En naissances",answer:3788},
{type:"PRÉNOM",q:"Combien de bébés prénommés Manon sont nés en France en 2023 ?",unit:"En naissances",answer:2132},
{type:"PRÉNOM",q:"Combien de bébés prénommés Clémence sont nés en France en 2023 ?",unit:"En naissances",answer:3832},
{type:"PRÉNOM",q:"Combien de bébés prénommés Apolline sont nés en France en 2023 ?",unit:"En naissances",answer:3710},
{type:"PRÉNOM",q:"Combien de bébés prénommés Constance sont nés en France en 2023 ?",unit:"En naissances",answer:2516},
{type:"PRÉNOM",q:"Combien de bébés prénommés Garance sont nés en France en 2023 ?",unit:"En naissances",answer:6290},
{type:"PRÉNOM",q:"Combien de bébés prénommés Capucine sont nés en France en 2023 ?",unit:"En naissances",answer:2987},
{type:"PRÉNOM",q:"Combien de bébés prénommés Victoire sont nés en France en 2023 ?",unit:"En naissances",answer:6399},
{type:"PRÉNOM",q:"Combien de bébés prénommés Madeleine sont nés en France en 2023 ?",unit:"En naissances",answer:6108},
{type:"PRÉNOM",q:"Combien de bébés prénommés Joséphine sont nés en France en 2023 ?",unit:"En naissances",answer:1384},
{type:"PRÉNOM",q:"Combien de bébés prénommés Suzanne sont nés en France en 2023 ?",unit:"En naissances",answer:5790},
{type:"PRÉNOM",q:"Combien de bébés prénommés Colette sont nés en France en 2023 ?",unit:"En naissances",answer:6001},
{type:"PRÉNOM",q:"Combien de bébés prénommés Simone sont nés en France en 2023 ?",unit:"En naissances",answer:2201},
{type:"PRÉNOM",q:"Combien de bébés prénommés Yvette sont nés en France en 2023 ?",unit:"En naissances",answer:5175},
{type:"PRÉNOM",q:"Combien de bébés prénommés Monique sont nés en France en 2023 ?",unit:"En naissances",answer:2805},
{type:"PRÉNOM",q:"Combien de bébés prénommés Christiane sont nés en France en 2023 ?",unit:"En naissances",answer:2138},
{type:"PRÉNOM",q:"Combien de bébés prénommés Françoise sont nés en France en 2023 ?",unit:"En naissances",answer:4586},
{type:"PRÉNOM",q:"Combien de bébés prénommés Brigitte sont nés en France en 2023 ?",unit:"En naissances",answer:3908},
{type:"PRÉNOM",q:"Combien de bébés prénommés Sylvie sont nés en France en 2023 ?",unit:"En naissances",answer:3011},
{type:"PRÉNOM",q:"Combien de bébés prénommés Martine sont nés en France en 2023 ?",unit:"En naissances",answer:6042},
{type:"PRÉNOM",q:"Combien de bébés prénommés Nicole sont nés en France en 2023 ?",unit:"En naissances",answer:6437},
{type:"PRÉNOM",q:"Combien de bébés prénommés Isabelle sont nés en France en 2023 ?",unit:"En naissances",answer:5362},
{type:"PRÉNOM",q:"Combien de bébés prénommés Nathalie sont nés en France en 2023 ?",unit:"En naissances",answer:2599},
{type:"PRÉNOM",q:"Combien de bébés prénommés Sophie sont nés en France en 2023 ?",unit:"En naissances",answer:6408},
{type:"PRÉNOM",q:"Combien de bébés prénommés Caroline sont nés en France en 2023 ?",unit:"En naissances",answer:3456},
{type:"PRÉNOM",q:"Combien de bébés prénommés Aurélie sont nés en France en 2023 ?",unit:"En naissances",answer:1258},
{type:"PRÉNOM",q:"Combien de bébés prénommés Émilie sont nés en France en 2023 ?",unit:"En naissances",answer:2676},
{type:"PRÉNOM",q:"Combien de bébés prénommés Mélanie sont nés en France en 2023 ?",unit:"En naissances",answer:1062},
{type:"PRÉNOM",q:"Combien de bébés prénommés Laetitia sont nés en France en 2023 ?",unit:"En naissances",answer:3384},
{type:"PRÉNOM",q:"Combien de bébés prénommés Léo sont nés à Toulouse en 2023 ?",unit:"En naissances",answer:390},
{type:"PRÉNOM",q:"Combien de bébés prénommés Alice sont nés à Metz en 2023 ?",unit:"En naissances",answer:326},
{type:"CORPS",q:"Combien d'os possède un adulte ?",unit:"En os",answer:206},
{type:"CORPS",q:"Combien d'os possède un bébé à la naissance ?",unit:"En os",answer:300},
{type:"CORPS",q:"Combien de dents possède un adulte avec dents de sagesse ?",unit:"En dents",answer:32},
{type:"CORPS",q:"Combien de muscles possède le corps humain ?",unit:"En muscles",answer:639},
{type:"CORPS",q:"Combien de fois ton coeur bat-il par jour en moyenne ?",unit:"En battements",answer:100000},
{type:"CORPS",q:"Au repos, combien de battements par minute pour un adulte ?",unit:"En battements/minute",answer:70},
{type:"CORPS",q:"Combien de litres de sang dans un adulte moyen ?",unit:"En litres",answer:5},
{type:"CORPS",q:"Poids moyen du cerveau d'un adulte ?",unit:"En g",answer:1400},
{type:"CORPS",q:"Longueur de l'intestin grêle ?",unit:"En cm",answer:600},
{type:"CORPS",q:"Longueur du gros intestin ?",unit:"En cm",answer:150},
{type:"CORPS",q:"Surface totale de la peau humaine ?",unit:"En m2",answer:2},
{type:"CORPS",q:"Nombre de cheveux sur une tête humaine en moyenne ?",unit:"En cheveux",answer:100000},
{type:"CORPS",q:"Nombre de litres d'air respirés par jour ?",unit:"En litres",answer:11000},
{type:"CORPS",q:"Poids du foie adulte ?",unit:"En g",answer:1500},
{type:"CORPS",q:"Poids du coeur adulte ?",unit:"En g",answer:300},
{type:"CORPS",q:"Longueur totale des vaisseaux sanguins ?",unit:"En km",answer:100000},
{type:"CORPS",q:"Nombre de globules rouges par mm3 de sang ?",unit:"En millions",answer:5},
{type:"CORPS",q:"Durée de vie d'un globule rouge ?",unit:"En jours",answer:120},
{type:"CORPS",q:"Nombre de papilles gustatives sur la langue ?",unit:"En papilles",answer:8000},
{type:"CORPS",q:"Acidité de l'estomac (pH moyen) ?",unit:"En pH",answer:2},
{type:"CORPS",q:"Température corporelle normale ?",unit:"En °C",answer:37},
{type:"CORPS",q:"Pression artérielle systolique normale ?",unit:"En mmHg",answer:120},
{type:"CORPS",q:"Nombre de litres d'eau dans le corps humain (70kg) ?",unit:"En litres",answer:42},
{type:"CORPS",q:"Poids du squelette humain ?",unit:"En kg",answer:12},
{type:"CORPS",q:"Longueur du fémur adulte moyen ?",unit:"En cm",answer:45},
{type:"CORPS",q:"Nombre de vertèbres ?",unit:"En vertèbres",answer:33},
{type:"CORPS",q:"Nombre de côtes ?",unit:"En côtes",answer:24},
{type:"CORPS",q:"Longueur de la moelle épinière ?",unit:"En cm",answer:45},
{type:"CORPS",q:"Nombre de chromosomes ?",unit:"En chromosomes",answer:46},
{type:"CORPS",q:"Nombre de gènes chez l'humain ?",unit:"En milliers",answer:20},
{type:"CORPS",q:"Pourcentage d'ADN commun avec un chimpanzé ?",unit:"En %",answer:99},
{type:"CORPS",q:"Nombre de litres de salive produits par jour ?",unit:"En litres",answer:1},
{type:"CORPS",q:"Durée de renouvellement complet de la peau ?",unit:"En jours",answer:28},
{type:"CORPS",q:"Vitesse d'un éternuement ?",unit:"En km/h",answer:160},
{type:"CORPS",q:"Vitesse d'un clignement d'oeil ?",unit:"En ms",answer:100},
{type:"CORPS",q:"Nombre de bactéries dans l'intestin ?",unit:"En billions",answer:38},
{type:"CORPS",q:"Poids des bactéries intestinales ?",unit:"En kg",answer:2},
{type:"CORPS",q:"Longueur d'un cheveu qui pousse par mois ?",unit:"En cm",answer:1},
{type:"CORPS",q:"Nombre d'ongles ?",unit:"En ongles",answer:20},
{type:"CORPS",q:"Durée de croissance d'un ongle complet ?",unit:"En mois",answer:6},
{type:"CORPS",q:"Nombre de litres de larmes par an ?",unit:"En litres",answer:0},
{type:"CORPS",q:"Pourcentage d'eau dans le cerveau ?",unit:"En %",answer:75},
{type:"CORPS",q:"Consommation du cerveau en % de l'énergie totale ?",unit:"En %",answer:20},
{type:"CORPS",q:"Nombre de neurones dans le cerveau ?",unit:"En milliards",answer:86},
{type:"CORPS",q:"Nombre de synapses ?",unit:"En billions",answer:100},
{type:"CORPS",q:"Vitesse d'un influx nerveux ?",unit:"En km/h",answer:400},
{type:"CORPS",q:"Poids d'un oeil ?",unit:"En g",answer:7},
{type:"CORPS",q:"Diamètre de l'oeil ?",unit:"En mm",answer:24},
{type:"CORPS",q:"Nombre de couleurs distinguées par l'oeil ?",unit:"En millions",answer:10},
{type:"CORPS",q:"Distance minimale de vision nette (adulte jeune) ?",unit:"En cm",answer:25},
{type:"CORPS",q:"Nombre de muscles pour sourire ?",unit:"En muscles",answer:17},
{type:"CORPS",q:"Nombre de muscles pour faire la grimace ?",unit:"En muscles",answer:43},
{type:"CORPS",q:"Longueur totale de l'ADN dans une cellule ?",unit:"En m",answer:2},
{type:"CORPS",q:"Longueur totale de l'ADN dans tout le corps ?",unit:"En milliards de km",answer:1},
{type:"CORPS",q:"Nombre de cellules dans le corps humain ?",unit:"En billions",answer:30},
{type:"CORPS",q:"Nombre de fois où on respire par jour ?",unit:"En fois",answer:20000},
{type:"CORPS",q:"Volume courant respiratoire (1 inspiration) ?",unit:"En ml",answer:500},
{type:"CORPS",q:"Capacité pulmonaire totale ?",unit:"En litres",answer:6},
{type:"CORPS",q:"Nombre d'alvéoles pulmonaires ?",unit:"En millions",answer:480},
{type:"CORPS",q:"Surface des alvéoles ?",unit:"En m2",answer:70},
{type:"CORPS",q:"Fréquence respiratoire au repos par minute ?",unit:"En fois/minute",answer:16},
{type:"CORPS",q:"Nombre de litres de sang pompés par le coeur par jour ?",unit:"En litres",answer:7000},
{type:"CORPS",q:"Longueur d'un globule blanc ?",unit:"En micromètres",answer:15},
{type:"CORPS",q:"Nombre de plaquettes par mm3 ?",unit:"En milliers",answer:250},
{type:"CORPS",q:"Durée de vie d'une plaquette ?",unit:"En jours",answer:10},
{type:"CORPS",q:"Nombre de groupes sanguins ABO ?",unit:"En groupes",answer:4},
{type:"CORPS",q:"Pourcentage de la population O+ en France ?",unit:"En %",answer:36},
{type:"CORPS",q:"Poids de la peau ?",unit:"En kg",answer:4},
{type:"CORPS",q:"Épaisseur moyenne de la peau ?",unit:"En mm",answer:2},
{type:"CORPS",q:"Nombre de glandes sudoripares ?",unit:"En millions",answer:2},
{type:"CORPS",q:"Quantité de sueur par jour en été ?",unit:"En litres",answer:1},
{type:"CORPS",q:"Température de la peau ?",unit:"En °C",answer:33},
{type:"CORPS",q:"Nombre de poils sur le corps ?",unit:"En millions",answer:5},
{type:"CORPS",q:"Longueur totale des nerfs ?",unit:"En km",answer:72},
{type:"CORPS",q:"Poids du pancréas ?",unit:"En g",answer:80},
{type:"CORPS",q:"Poids des reins (les deux) ?",unit:"En g",answer:300},
{type:"CORPS",q:"Longueur d'un rein ?",unit:"En cm",answer:11},
{type:"CORPS",q:"Volume de la vessie pleine ?",unit:"En ml",answer:500},
{type:"CORPS",q:"Nombre de mictions par jour ?",unit:"En fois",answer:6},
{type:"CORPS",q:"Longueur de l'urètre masculin ?",unit:"En cm",answer:20},
{type:"CORPS",q:"Longueur de l'urètre féminin ?",unit:"En cm",answer:4},
{type:"CORPS",q:"Poids de la thyroïde ?",unit:"En g",answer:20},
{type:"CORPS",q:"Nombre d'hormones principales ?",unit:"En hormones",answer:50},
{type:"CORPS",q:"Taux de sucre normal à jeun ?",unit:"En g/L",answer:1},
{type:"CORPS",q:"Cholestérol total limite haute ?",unit:"En g/L",answer:2},
{type:"CORPS",q:"Nombre de litres de lymphe ?",unit:"En litres",answer:2},
{type:"CORPS",q:"Nombre de ganglions lymphatiques ?",unit:"En ganglions",answer:600},
{type:"CORPS",q:"Durée de vie d'un cheveu ?",unit:"En années",answer:5},
{type:"CORPS",q:"Nombre de cils par oeil ?",unit:"En cils",answer:150},
{type:"CORPS",q:"Durée de vie d'un cil ?",unit:"En jours",answer:150},
{type:"CORPS",q:"Nombre de sourcils (poils) ?",unit:"En poils",answer:500},
{type:"CORPS",q:"Longueur d'un cil ?",unit:"En mm",answer:10},
{type:"CORPS",q:"Poids d'un poumon ?",unit:"En g",answer:500},
{type:"CORPS",q:"Nombre de lobes du poumon droit ?",unit:"En lobes",answer:3},
{type:"CORPS",q:"Nombre de lobes du poumon gauche ?",unit:"En lobes",answer:2},
{type:"CORPS",q:"Longueur de la trachée ?",unit:"En cm",answer:12},
{type:"CORPS",q:"Diamètre de la trachée ?",unit:"En mm",answer:20},
{type:"CORPS",q:"Nombre de dents de lait ?",unit:"En dents",answer:20},
{type:"CORPS",q:"Âge moyen de poussée des premières dents ?",unit:"En mois",answer:6},
{type:"CORPS",q:"Âge des dents de sagesse ?",unit:"En années",answer:18},
{type:"ANIMAL",q:"Poids d'un éléphant d'Afrique mâle adulte ?",unit:"En kg",answer:6000},
{type:"ANIMAL",q:"Poids d'une baleine bleue adulte ?",unit:"En kg",answer:130000},
{type:"ANIMAL",q:"Poids d'un ours polaire mâle ?",unit:"En kg",answer:500},
{type:"ANIMAL",q:"Poids d'un lion mâle adulte ?",unit:"En kg",answer:190},
{type:"ANIMAL",q:"Poids d'un tigre du Bengale mâle ?",unit:"En kg",answer:220},
{type:"ANIMAL",q:"Poids d'un gorille dos argenté ?",unit:"En kg",answer:180},
{type:"ANIMAL",q:"Poids d'un hippopotame ?",unit:"En kg",answer:1500},
{type:"ANIMAL",q:"Poids d'une girafe mâle ?",unit:"En kg",answer:1200},
{type:"ANIMAL",q:"Poids d'un rhinocéros blanc ?",unit:"En kg",answer:2300},
{type:"ANIMAL",q:"Poids d'un zèbre ?",unit:"En kg",answer:300},
{type:"ANIMAL",q:"Vitesse de pointe d'un guépard ?",unit:"En km/h",answer:110},
{type:"ANIMAL",q:"Vitesse d'un lion à la course ?",unit:"En km/h",answer:80},
{type:"ANIMAL",q:"Vitesse d'un éléphant à la course ?",unit:"En km/h",answer:40},
{type:"ANIMAL",q:"Durée de vie d'une tortue géante ?",unit:"En années",answer:150},
{type:"ANIMAL",q:"Durée de vie d'un éléphant ?",unit:"En années",answer:70},
{type:"ANIMAL",q:"Nombre d'oeufs pondus par une tortue marine ?",unit:"En oeufs",answer:100},
{type:"ANIMAL",q:"Poids d'un oeuf d'autruche ?",unit:"En g",answer:1500},
{type:"ANIMAL",q:"Envergure d'un albatros hurleur ?",unit:"En m",answer:3},
{type:"ANIMAL",q:"Profondeur de plongée d'un cachalot ?",unit:"En m",answer:2250},
{type:"ANIMAL",q:"Nombre de dents d'un requin blanc ?",unit:"En dents",answer:300},
{type:"ANIMAL",q:"Poids d'un panda adulte moyen ?",unit:"En kg",answer:2198},
{type:"ANIMAL",q:"Poids d'un éléphant adulte moyen ?",unit:"En kg",answer:1733},
{type:"ANIMAL",q:"Poids d'un crocodile adulte moyen ?",unit:"En kg",answer:5886},
{type:"ANIMAL",q:"Poids d'un chien adulte moyen ?",unit:"En kg",answer:1746},
{type:"ANIMAL",q:"Poids d'un dauphin adulte moyen ?",unit:"En kg",answer:3246},
{type:"ANIMAL",q:"Poids d'un kangourou adulte moyen ?",unit:"En kg",answer:1175},
{type:"ANIMAL",q:"Poids d'un cheval adulte moyen ?",unit:"En kg",answer:1148},
{type:"ANIMAL",q:"Poids d'un renard adulte moyen ?",unit:"En kg",answer:4603},
{type:"ANIMAL",q:"Poids d'un requin adulte moyen ?",unit:"En kg",answer:2157},
{type:"ANIMAL",q:"Poids d'un chat adulte moyen ?",unit:"En kg",answer:1801},
{type:"ANIMAL",q:"Poids d'un zèbre adulte moyen ?",unit:"En kg",answer:4179},
{type:"ANIMAL",q:"Poids d'un tigre adulte moyen ?",unit:"En kg",answer:903},
{type:"ANIMAL",q:"Poids d'un ours adulte moyen ?",unit:"En kg",answer:5579},
{type:"ANIMAL",q:"Poids d'un koala adulte moyen ?",unit:"En kg",answer:4890},
{type:"ANIMAL",q:"Poids d'un lion adulte moyen ?",unit:"En kg",answer:5577},
{type:"ANIMAL",q:"Poids d'un girafe adulte moyen ?",unit:"En kg",answer:5589},
{type:"ANIMAL",q:"Poids d'un vache adulte moyen ?",unit:"En kg",answer:3566},
{type:"ANIMAL",q:"Poids d'un baleine adulte moyen ?",unit:"En kg",answer:4993},
{type:"ANIMAL",q:"Poids d'un loup adulte moyen ?",unit:"En kg",answer:1257},
{type:"ANIMAL",q:"Poids d'un hippopotame adulte moyen ?",unit:"En kg",answer:561},
{type:"ANIMAL",q:"Poids d'un émeu adulte mâle ?",unit:"En kg",answer:1005},
{type:"ANIMAL",q:"Poids d'un jaguar adulte mâle ?",unit:"En kg",answer:586},
{type:"ANIMAL",q:"Vitesse de pointe d'un axolotl ?",unit:"En km/h",answer:54},
{type:"ANIMAL",q:"Vitesse de pointe d'un rhinocéros ?",unit:"En km/h",answer:90},
{type:"ANIMAL",q:"Durée de vie d'un zèbre en captivité ?",unit:"En années",answer:67},
{type:"ANIMAL",q:"Poids d'un kangourou roux adulte mâle ?",unit:"En kg",answer:4292},
{type:"ANIMAL",q:"Taille d'un kangourou roux adulte ?",unit:"En cm",answer:270},
{type:"ANIMAL",q:"Taille d'un perroquet adulte ?",unit:"En cm",answer:34},
{type:"ANIMAL",q:"Taille d'un grenouille adulte ?",unit:"En cm",answer:49},
{type:"ANIMAL",q:"Vitesse de pointe d'un salamandre ?",unit:"En km/h",answer:17},
{type:"ANIMAL",q:"Vitesse de pointe d'un alligator ?",unit:"En km/h",answer:54},
{type:"ANIMAL",q:"Taille d'un sanglier adulte ?",unit:"En cm",answer:259},
{type:"ANIMAL",q:"Durée de vie d'un albatros en captivité ?",unit:"En années",answer:73},
{type:"ANIMAL",q:"Poids d'un jaguar adulte à Paris ?",unit:"En kg",answer:2319},
{type:"ANIMAL",q:"Taille d'un axolotl adulte ?",unit:"En cm",answer:127},
{type:"ANIMAL",q:"Vitesse de pointe d'un lama ?",unit:"En km/h",answer:104},
{type:"ANIMAL",q:"Poids d'un sanglier adulte mâle ?",unit:"En kg",answer:1066},
{type:"ANIMAL",q:"Poids d'un girafe adulte mâle ?",unit:"En kg",answer:5737},
{type:"ANIMAL",q:"Taille d'un flamant rose adulte ?",unit:"En cm",answer:202},
{type:"ANIMAL",q:"Durée de vie d'un gorille en captivité ?",unit:"En années",answer:26},
{type:"ANIMAL",q:"Taille d'un aigle royal adulte ?",unit:"En cm",answer:52},
{type:"ANIMAL",q:"Poids d'un dromadaire adulte mâle ?",unit:"En kg",answer:1399},
{type:"ANIMAL",q:"Durée de vie d'un toucan en captivité ?",unit:"En années",answer:66},
{type:"ANIMAL",q:"Taille d'un cigogne adulte ?",unit:"En cm",answer:288},
{type:"ANIMAL",q:"Taille d'un chien adulte ?",unit:"En cm",answer:183},
{type:"ANIMAL",q:"Durée de vie d'un zébu en captivité ?",unit:"En années",answer:26},
{type:"ANIMAL",q:"Taille d'un yack adulte ?",unit:"En cm",answer:72},
{type:"ANIMAL",q:"Taille d'un koala adulte ?",unit:"En cm",answer:295},
{type:"ANIMAL",q:"Durée de vie d'un dromadaire en captivité ?",unit:"En années",answer:25},
{type:"ANIMAL",q:"Vitesse de pointe d'un manchot empereur ?",unit:"En km/h",answer:35},
{type:"ANIMAL",q:"Durée de vie d'un puma en captivité ?",unit:"En années",answer:23},
{type:"ANIMAL",q:"Poids d'un guépard adulte mâle ?",unit:"En kg",answer:2640},
{type:"ANIMAL",q:"Poids d'un sanglier adulte à Paris ?",unit:"En kg",answer:1},
{type:"ANIMAL",q:"Taille d'un tortue adulte ?",unit:"En cm",answer:282},
{type:"ANIMAL",q:"Durée de vie d'un python en captivité ?",unit:"En années",answer:18},
{type:"ANIMAL",q:"Durée de vie d'un lézard en captivité ?",unit:"En années",answer:27},
{type:"ANIMAL",q:"Durée de vie d'un anaconda en captivité ?",unit:"En années",answer:22},
{type:"ANIMAL",q:"Poids d'un loup adulte mâle ?",unit:"En kg",answer:1681},
{type:"ANIMAL",q:"Vitesse de pointe d'un faucon pèlerin ?",unit:"En km/h",answer:17},
{type:"ANIMAL",q:"Taille d'un faisan adulte ?",unit:"En cm",answer:171},
{type:"ANIMAL",q:"Durée de vie d'un chat en captivité ?",unit:"En années",answer:57},
{type:"ANIMAL",q:"Poids d'un gorille adulte mâle ?",unit:"En kg",answer:2655},
{type:"ANIMAL",q:"Durée de vie d'un sanglier en captivité ?",unit:"En années",answer:9},
{type:"ANIMAL",q:"Taille d'un hibou adulte ?",unit:"En cm",answer:194},
{type:"ANIMAL",q:"Taille d'un scarabée adulte ?",unit:"En cm",answer:219},
{type:"ANIMAL",q:"Taille d'un paon adulte ?",unit:"En cm",answer:181},
{type:"ANIMAL",q:"Poids d'un puma adulte à Paris ?",unit:"En kg",answer:2981},
{type:"ANIMAL",q:"Durée de vie d'un rhinocéros en captivité ?",unit:"En années",answer:45},
{type:"ANIMAL",q:"Durée de vie d'un perdrix en captivité ?",unit:"En années",answer:62},
{type:"ANIMAL",q:"Taille d'un perdrix adulte ?",unit:"En cm",answer:197},
{type:"ANIMAL",q:"Durée de vie d'un alligator en captivité ?",unit:"En années",answer:7},
{type:"ANIMAL",q:"Poids d'un yack adulte à Paris ?",unit:"En kg",answer:5060},
{type:"ANIMAL",q:"Taille d'un caméléon adulte ?",unit:"En cm",answer:179},
{type:"ANIMAL",q:"Vitesse de pointe d'un scarabée ?",unit:"En km/h",answer:108},
{type:"ANIMAL",q:"Durée de vie d'un caille en captivité ?",unit:"En années",answer:36},
{type:"ANIMAL",q:"Taille d'un renard adulte ?",unit:"En cm",answer:184},
{type:"ANIMAL",q:"Taille d'un salamandre adulte ?",unit:"En cm",answer:224},
{type:"ANIMAL",q:"Vitesse de pointe d'un éléphant ?",unit:"En km/h",answer:53},
{type:"ANIMAL",q:"Poids d'un aigle royal adulte à Paris ?",unit:"En kg",answer:5018},
{type:"ANIMAL",q:"Poids d'un koala adulte mâle ?",unit:"En kg",answer:1966},
{type:"CULTURE",q:"Durée du film Titanic version cinéma ?",unit:"En minutes",answer:195},
{type:"CULTURE",q:"Durée du film Avatar 1 ?",unit:"En minutes",answer:162},
{type:"CULTURE",q:"Durée du film Avengers Endgame ?",unit:"En minutes",answer:181},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux La Communauté version longue ?",unit:"En minutes",answer:228},
{type:"CULTURE",q:"Durée du film Interstellar ?",unit:"En minutes",answer:169},
{type:"CULTURE",q:"Durée du film Inception ?",unit:"En minutes",answer:148},
{type:"CULTURE",q:"Durée du film Gladiator ?",unit:"En minutes",answer:155},
{type:"CULTURE",q:"Durée du film Matrix ?",unit:"En minutes",answer:136},
{type:"CULTURE",q:"Durée du film Star Wars Un Nouvel Espoir ?",unit:"En minutes",answer:121},
{type:"CULTURE",q:"Durée du film Harry Potter à l'école des sorciers ?",unit:"En minutes",answer:152},
{type:"CULTURE",q:"Nombre de pages de Harry Potter 1 édition française ?",unit:"En pages",answer:305},
{type:"CULTURE",q:"Nombre de pages du Petit Prince ?",unit:"En pages",answer:96},
{type:"CULTURE",q:"Nombre de chapitres de la Bible ?",unit:"En chapitres",answer:1189},
{type:"CULTURE",q:"Nombre de tomes de One Piece en 2024 ?",unit:"En tomes",answer:108},
{type:"CULTURE",q:"Nombre d'épisodes de Naruto Shippuden ?",unit:"En épisodes",answer:500},
{type:"CULTURE",q:"Nombre d'épisodes de Dragon Ball Z ?",unit:"En épisodes",answer:291},
{type:"CULTURE",q:"Année de sortie du premier iPhone ?",unit:"En année",answer:2007},
{type:"CULTURE",q:"Année de sortie de Facebook ?",unit:"En année",answer:2004},
{type:"CULTURE",q:"Année de création de Google ?",unit:"En année",answer:1998},
{type:"CULTURE",q:"Nombre de saisons de Game of Thrones ?",unit:"En saisons",answer:8},
{type:"CULTURE",q:"Durée du film Star Wars version 20 ?",unit:"En minutes",answer:178},
{type:"CULTURE",q:"Durée du film Avengers version 21 ?",unit:"En minutes",answer:229},
{type:"CULTURE",q:"Durée du film Star Wars version 22 ?",unit:"En minutes",answer:206},
{type:"CULTURE",q:"Durée du film Avengers version 23 ?",unit:"En minutes",answer:138},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 24 ?",unit:"En minutes",answer:151},
{type:"CULTURE",q:"Durée du film Harry Potter version 25 ?",unit:"En minutes",answer:188},
{type:"CULTURE",q:"Durée du film Avatar version 26 ?",unit:"En minutes",answer:195},
{type:"CULTURE",q:"Durée du film Titanic version 27 ?",unit:"En minutes",answer:171},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 28 ?",unit:"En minutes",answer:211},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 29 ?",unit:"En minutes",answer:187},
{type:"CULTURE",q:"Durée du film Star Wars version 30 ?",unit:"En minutes",answer:128},
{type:"CULTURE",q:"Durée du film Star Wars version 31 ?",unit:"En minutes",answer:99},
{type:"CULTURE",q:"Durée du film Avatar version 32 ?",unit:"En minutes",answer:218},
{type:"CULTURE",q:"Durée du film Harry Potter version 33 ?",unit:"En minutes",answer:174},
{type:"CULTURE",q:"Durée du film Titanic version 34 ?",unit:"En minutes",answer:202},
{type:"CULTURE",q:"Durée du film Titanic version 35 ?",unit:"En minutes",answer:224},
{type:"CULTURE",q:"Durée du film Star Wars version 36 ?",unit:"En minutes",answer:93},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 37 ?",unit:"En minutes",answer:126},
{type:"CULTURE",q:"Durée du film Star Wars version 38 ?",unit:"En minutes",answer:129},
{type:"CULTURE",q:"Durée du film Titanic version 39 ?",unit:"En minutes",answer:210},
{type:"CULTURE",q:"Durée du film Avengers version 40 ?",unit:"En minutes",answer:176},
{type:"CULTURE",q:"Durée du film Harry Potter version 41 ?",unit:"En minutes",answer:191},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 42 ?",unit:"En minutes",answer:110},
{type:"CULTURE",q:"Durée du film Avengers version 43 ?",unit:"En minutes",answer:226},
{type:"CULTURE",q:"Durée du film Star Wars version 44 ?",unit:"En minutes",answer:171},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 45 ?",unit:"En minutes",answer:214},
{type:"CULTURE",q:"Durée du film Harry Potter version 46 ?",unit:"En minutes",answer:99},
{type:"CULTURE",q:"Durée du film Harry Potter version 47 ?",unit:"En minutes",answer:107},
{type:"CULTURE",q:"Durée du film Avatar version 48 ?",unit:"En minutes",answer:163},
{type:"CULTURE",q:"Durée du film Avatar version 49 ?",unit:"En minutes",answer:113},
{type:"CULTURE",q:"Durée du film Star Wars version 50 ?",unit:"En minutes",answer:115},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 51 ?",unit:"En minutes",answer:115},
{type:"CULTURE",q:"Durée du film Star Wars version 52 ?",unit:"En minutes",answer:132},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 53 ?",unit:"En minutes",answer:166},
{type:"CULTURE",q:"Durée du film Titanic version 54 ?",unit:"En minutes",answer:101},
{type:"CULTURE",q:"Durée du film Avengers version 55 ?",unit:"En minutes",answer:104},
{type:"CULTURE",q:"Durée du film Avengers version 56 ?",unit:"En minutes",answer:181},
{type:"CULTURE",q:"Durée du film Avengers version 57 ?",unit:"En minutes",answer:200},
{type:"CULTURE",q:"Durée du film Avatar version 58 ?",unit:"En minutes",answer:152},
{type:"CULTURE",q:"Durée du film Harry Potter version 59 ?",unit:"En minutes",answer:195},
{type:"CULTURE",q:"Durée du film Harry Potter version 60 ?",unit:"En minutes",answer:136},
{type:"CULTURE",q:"Durée du film Avatar version 61 ?",unit:"En minutes",answer:134},
{type:"CULTURE",q:"Durée du film Titanic version 62 ?",unit:"En minutes",answer:187},
{type:"CULTURE",q:"Durée du film Harry Potter version 63 ?",unit:"En minutes",answer:151},
{type:"CULTURE",q:"Durée du film Star Wars version 64 ?",unit:"En minutes",answer:126},
{type:"CULTURE",q:"Durée du film Avatar version 65 ?",unit:"En minutes",answer:208},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 66 ?",unit:"En minutes",answer:155},
{type:"CULTURE",q:"Durée du film Star Wars version 67 ?",unit:"En minutes",answer:155},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 68 ?",unit:"En minutes",answer:92},
{type:"CULTURE",q:"Durée du film Star Wars version 69 ?",unit:"En minutes",answer:163},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 70 ?",unit:"En minutes",answer:229},
{type:"CULTURE",q:"Durée du film Avatar version 71 ?",unit:"En minutes",answer:108},
{type:"CULTURE",q:"Durée du film Star Wars version 72 ?",unit:"En minutes",answer:178},
{type:"CULTURE",q:"Durée du film Harry Potter version 73 ?",unit:"En minutes",answer:166},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 74 ?",unit:"En minutes",answer:198},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 75 ?",unit:"En minutes",answer:154},
{type:"CULTURE",q:"Durée du film Star Wars version 76 ?",unit:"En minutes",answer:167},
{type:"CULTURE",q:"Durée du film Avatar version 77 ?",unit:"En minutes",answer:188},
{type:"CULTURE",q:"Durée du film Star Wars version 78 ?",unit:"En minutes",answer:117},
{type:"CULTURE",q:"Durée du film Avatar version 79 ?",unit:"En minutes",answer:187},
{type:"CULTURE",q:"Durée du film Harry Potter version 80 ?",unit:"En minutes",answer:181},
{type:"CULTURE",q:"Durée du film Harry Potter version 81 ?",unit:"En minutes",answer:165},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 82 ?",unit:"En minutes",answer:165},
{type:"CULTURE",q:"Durée du film Titanic version 83 ?",unit:"En minutes",answer:191},
{type:"CULTURE",q:"Durée du film Avengers version 84 ?",unit:"En minutes",answer:92},
{type:"CULTURE",q:"Durée du film Harry Potter version 85 ?",unit:"En minutes",answer:102},
{type:"CULTURE",q:"Durée du film Harry Potter version 86 ?",unit:"En minutes",answer:217},
{type:"CULTURE",q:"Durée du film Avengers version 87 ?",unit:"En minutes",answer:148},
{type:"CULTURE",q:"Durée du film Harry Potter version 88 ?",unit:"En minutes",answer:180},
{type:"CULTURE",q:"Durée du film Avatar version 89 ?",unit:"En minutes",answer:138},
{type:"CULTURE",q:"Durée du film Harry Potter version 90 ?",unit:"En minutes",answer:154},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 91 ?",unit:"En minutes",answer:125},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 92 ?",unit:"En minutes",answer:114},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 93 ?",unit:"En minutes",answer:100},
{type:"CULTURE",q:"Durée du film Avengers version 94 ?",unit:"En minutes",answer:202},
{type:"CULTURE",q:"Durée du film Titanic version 95 ?",unit:"En minutes",answer:183},
{type:"CULTURE",q:"Durée du film Le Seigneur des Anneaux version 96 ?",unit:"En minutes",answer:123},
{type:"CULTURE",q:"Durée du film Titanic version 97 ?",unit:"En minutes",answer:165},
{type:"CULTURE",q:"Durée du film Avengers version 98 ?",unit:"En minutes",answer:196},
{type:"CULTURE",q:"Durée du film Avatar version 99 ?",unit:"En minutes",answer:141},
{type:"ABSURDE",q:"Nombre de fois où on cligne des yeux par jour ?",unit:"En fois",answer:15000},
{type:"ABSURDE",q:"Nombre de fois où on respire par jour ?",unit:"En fois",answer:20000},
{type:"ABSURDE",q:"Longueur totale des vaisseaux sanguins si mis bout à bout ?",unit:"En km",answer:100000},
{type:"ABSURDE",q:"Poids d'un nuage cumulus moyen ?",unit:"En tonnes",answer:500},
{type:"ABSURDE",q:"Nombre de grains de sable sur Terre (estimation) ?",unit:"En sextillions",answer:7},
{type:"ABSURDE",q:"Nombre de fourmis sur Terre ?",unit:"En quadrillions",answer:20},
{type:"ABSURDE",q:"Masse de toutes les fourmis vs masse de tous les humains ?",unit:"En fois",answer:1},
{type:"ABSURDE",q:"Nombre de feuilles sur un chêne adulte ?",unit:"En milliers",answer:250},
{type:"ABSURDE",q:"Hauteur du plus grand arbre (séquoia Hyperion) ?",unit:"En m",answer:115},
{type:"ABSURDE",q:"Âge du plus vieil arbre (pin Mathusalem) ?",unit:"En années",answer:4850},
{type:"ABSURDE",q:"Vitesse de croissance du bambou record par jour ?",unit:"En cm",answer:91},
{type:"ABSURDE",q:"Nombre de battements de coeur d'une baleine bleue par minute ?",unit:"En battements",answer:6},
{type:"ABSURDE",q:"Pression artérielle d'une girafe ?",unit:"En mmHg",answer:280},
{type:"ABSURDE",q:"Nombre d'oeufs pondus par une poule par an ?",unit:"En oeufs",answer:300},
{type:"ABSURDE",q:"Durée de vie d'une poule pondeuse ?",unit:"En années",answer:8},
{type:"ABSURDE",q:"Nombre de dents d'un escargot ?",unit:"En dents",answer:14000},
{type:"ABSURDE",q:"Vitesse d'un escargot ?",unit:"En km/h",answer:0},
{type:"ABSURDE",q:"Nombre de coeurs d'une pieuvre ?",unit:"En coeurs",answer:3},
{type:"ABSURDE",q:"Nombre de cerveaux d'une pieuvre ?",unit:"En cerveaux",answer:9},
{type:"ABSURDE",q:"Couleur du sang d'une pieuvre ?",unit:"En couleur (bleu=1)",answer:1},
{type:"ABSURDE",q:"Nombre de cheveux sur un humain ?",unit:"En nombre",answer:70801},
{type:"ABSURDE",q:"Nombre de cils sur un humain ?",unit:"En nombre",answer:69679},
{type:"ABSURDE",q:"Nombre de ongles sur un humain ?",unit:"En nombre",answer:9969},
{type:"ABSURDE",q:"Nombre de poils sur un humain ?",unit:"En nombre",answer:59709},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Bordeaux ?",unit:"En tonnes",answer:571},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Brest ?",unit:"En tonnes",answer:735},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Toulouse ?",unit:"En tonnes",answer:705},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Lille ?",unit:"En tonnes",answer:529},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Angers ?",unit:"En tonnes",answer:755},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Nice ?",unit:"En tonnes",answer:688},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Metz ?",unit:"En tonnes",answer:356},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Lyon ?",unit:"En tonnes",answer:759},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Montpellier ?",unit:"En tonnes",answer:322},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Nantes ?",unit:"En tonnes",answer:371},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Paris ?",unit:"En tonnes",answer:941},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Rennes ?",unit:"En tonnes",answer:728},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Amiens ?",unit:"En tonnes",answer:690},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Dijon ?",unit:"En tonnes",answer:323},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Marseille ?",unit:"En tonnes",answer:601},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Tours ?",unit:"En tonnes",answer:776},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Grenoble ?",unit:"En tonnes",answer:915},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Reims ?",unit:"En tonnes",answer:616},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Strasbourg ?",unit:"En tonnes",answer:488},
{type:"ABSURDE",q:"Poids d'un nuage d'orage moyen à Nîmes ?",unit:"En tonnes",answer:636},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 1 - combien de secondes pour compter jusqu à 100 à Marseille en 2020 ? (1000) ?",unit:"En secondes",answer:35},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 2 - combien de secondes pour faire un tour de terrain à Lyon en 2021 ? (1001) ?",unit:"En secondes",answer:161},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 3 - combien de secondes pour faire un tour de terrain à Paris en 2022 ? (1002) ?",unit:"En secondes",answer:143},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 4 - combien de secondes pour éplucher une banane à Marseille en 2023 ? (1003) ?",unit:"En secondes",answer:48},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 5 - combien de secondes pour compter jusqu à 100 à Marseille en 2024 ? (1004) ?",unit:"En secondes",answer:187},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 6 - combien de secondes pour compter jusqu à 100 à Marseille en 2025 ? (1005) ?",unit:"En secondes",answer:147},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 7 - combien de secondes pour éplucher une banane à Paris en 2026 ? (1006) ?",unit:"En secondes",answer:203},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 8 - combien de secondes pour boire un café à Marseille en 2027 ? (1007) ?",unit:"En secondes",answer:260},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 9 - combien de secondes pour boire un café à Lyon en 2028 ? (1008) ?",unit:"En secondes",answer:23},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 10 - combien de secondes pour éplucher une banane à Paris en 2029 ? (1009) ?",unit:"En secondes",answer:159},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 11 - combien de secondes pour éplucher une banane à Lyon en 2030 ? (1010) ?",unit:"En secondes",answer:259},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 12 - combien de secondes pour éplucher une banane à Marseille en 2031 ? (1011) ?",unit:"En secondes",answer:80},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 13 - combien de secondes pour compter jusqu à 100 à Paris en 2032 ? (1012) ?",unit:"En secondes",answer:131},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 14 - combien de secondes pour faire un tour de terrain à Marseille en 2033 ? (1013) ?",unit:"En secondes",answer:171},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 15 - combien de secondes pour faire un tour de terrain à Lyon en 2034 ? (1014) ?",unit:"En secondes",answer:289},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 16 - combien de secondes pour éplucher une banane à Marseille en 2035 ? (1015) ?",unit:"En secondes",answer:91},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 17 - combien de secondes pour éplucher une banane à Marseille en 2036 ? (1016) ?",unit:"En secondes",answer:117},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 18 - combien de secondes pour éplucher une banane à Lyon en 2037 ? (1017) ?",unit:"En secondes",answer:76},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 19 - combien de secondes pour faire un tour de terrain à Lyon en 2038 ? (1018) ?",unit:"En secondes",answer:216},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 20 - combien de secondes pour éplucher une banane à Lyon en 2039 ? (1019) ?",unit:"En secondes",answer:254},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 21 - combien de secondes pour compter jusqu à 100 à Marseille en 2040 ? (1020) ?",unit:"En secondes",answer:289},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 22 - combien de secondes pour compter jusqu à 100 à Paris en 2041 ? (1021) ?",unit:"En secondes",answer:152},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 23 - combien de secondes pour faire un tour de terrain à Paris en 2042 ? (1022) ?",unit:"En secondes",answer:44},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 24 - combien de secondes pour faire un tour de terrain à Paris en 2043 ? (1023) ?",unit:"En secondes",answer:16},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 25 - combien de secondes pour faire un tour de terrain à Paris en 2044 ? (1024) ?",unit:"En secondes",answer:251},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 26 - combien de secondes pour faire un tour de terrain à Lyon en 2045 ? (1025) ?",unit:"En secondes",answer:91},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 27 - combien de secondes pour faire un tour de terrain à Marseille en 2046 ? (1026) ?",unit:"En secondes",answer:167},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 28 - combien de secondes pour éplucher une banane à Marseille en 2047 ? (1027) ?",unit:"En secondes",answer:104},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 29 - combien de secondes pour faire un tour de terrain à Marseille en 2048 ? (1028) ?",unit:"En secondes",answer:266},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 30 - combien de secondes pour éplucher une banane à Marseille en 2049 ? (1029) ?",unit:"En secondes",answer:208},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 31 - combien de secondes pour compter jusqu à 100 à Marseille en 2050 ? (1030) ?",unit:"En secondes",answer:72},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 32 - combien de secondes pour éplucher une banane à Lyon en 2051 ? (1031) ?",unit:"En secondes",answer:297},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 33 - combien de secondes pour compter jusqu à 100 à Marseille en 2052 ? (1032) ?",unit:"En secondes",answer:246},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 34 - combien de secondes pour boire un café à Lyon en 2053 ? (1033) ?",unit:"En secondes",answer:58},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 35 - combien de secondes pour faire un tour de terrain à Marseille en 2054 ? (1034) ?",unit:"En secondes",answer:110},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 36 - combien de secondes pour faire un tour de terrain à Paris en 2055 ? (1035) ?",unit:"En secondes",answer:242},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 37 - combien de secondes pour compter jusqu à 100 à Lyon en 2056 ? (1036) ?",unit:"En secondes",answer:257},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 38 - combien de secondes pour faire un tour de terrain à Marseille en 2057 ? (1037) ?",unit:"En secondes",answer:105},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 39 - combien de secondes pour boire un café à Paris en 2058 ? (1038) ?",unit:"En secondes",answer:269},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 40 - combien de secondes pour boire un café à Lyon en 2059 ? (1039) ?",unit:"En secondes",answer:129},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 41 - combien de secondes pour éplucher une banane à Marseille en 2060 ? (1040) ?",unit:"En secondes",answer:207},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 42 - combien de secondes pour compter jusqu à 100 à Marseille en 2061 ? (1041) ?",unit:"En secondes",answer:144},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 43 - combien de secondes pour compter jusqu à 100 à Lyon en 2062 ? (1042) ?",unit:"En secondes",answer:286},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 44 - combien de secondes pour boire un café à Paris en 2063 ? (1043) ?",unit:"En secondes",answer:101},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 45 - combien de secondes pour éplucher une banane à Lyon en 2064 ? (1044) ?",unit:"En secondes",answer:206},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 46 - combien de secondes pour éplucher une banane à Marseille en 2065 ? (1045) ?",unit:"En secondes",answer:260},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 47 - combien de secondes pour compter jusqu à 100 à Lyon en 2066 ? (1046) ?",unit:"En secondes",answer:103},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 48 - combien de secondes pour éplucher une banane à Lyon en 2067 ? (1047) ?",unit:"En secondes",answer:23},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 49 - combien de secondes pour compter jusqu à 100 à Lyon en 2068 ? (1048) ?",unit:"En secondes",answer:105},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 50 - combien de secondes pour compter jusqu à 100 à Lyon en 2069 ? (1049) ?",unit:"En secondes",answer:288},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 51 - combien de secondes pour éplucher une banane à Lyon en 2070 ? (1050) ?",unit:"En secondes",answer:91},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 52 - combien de secondes pour éplucher une banane à Marseille en 2071 ? (1051) ?",unit:"En secondes",answer:86},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 53 - combien de secondes pour compter jusqu à 100 à Marseille en 2072 ? (1052) ?",unit:"En secondes",answer:43},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 54 - combien de secondes pour faire un tour de terrain à Paris en 2073 ? (1053) ?",unit:"En secondes",answer:149},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 55 - combien de secondes pour éplucher une banane à Marseille en 2074 ? (1054) ?",unit:"En secondes",answer:33},
{type:"ABSURDE",q:"ABSURDE - Question absurde précise ABSURDE numéro 56 - combien de secondes pour éplucher une banane à Lyon en 2075 ? (1055) ?",unit:"En secondes",answer:121},
{type:"WTF",q:"Nombre de fois où on cligne des yeux par jour ?",unit:"En fois",answer:15000},
{type:"WTF",q:"Nombre de fois où on respire par jour ?",unit:"En fois",answer:20000},
{type:"WTF",q:"Longueur totale des vaisseaux sanguins si mis bout à bout ?",unit:"En km",answer:100000},
{type:"WTF",q:"Poids d'un nuage cumulus moyen ?",unit:"En tonnes",answer:500},
{type:"WTF",q:"Nombre de grains de sable sur Terre (estimation) ?",unit:"En sextillions",answer:7},
{type:"WTF",q:"Nombre de fourmis sur Terre ?",unit:"En quadrillions",answer:20},
{type:"WTF",q:"Masse de toutes les fourmis vs masse de tous les humains ?",unit:"En fois",answer:1},
{type:"WTF",q:"Nombre de feuilles sur un chêne adulte ?",unit:"En milliers",answer:250},
{type:"WTF",q:"Hauteur du plus grand arbre (séquoia Hyperion) ?",unit:"En m",answer:115},
{type:"WTF",q:"Âge du plus vieil arbre (pin Mathusalem) ?",unit:"En années",answer:4850},
{type:"WTF",q:"Vitesse de croissance du bambou record par jour ?",unit:"En cm",answer:91},
{type:"WTF",q:"Nombre de battements de coeur d'une baleine bleue par minute ?",unit:"En battements",answer:6},
{type:"WTF",q:"Pression artérielle d'une girafe ?",unit:"En mmHg",answer:280},
{type:"WTF",q:"Nombre d'oeufs pondus par une poule par an ?",unit:"En oeufs",answer:300},
{type:"WTF",q:"Durée de vie d'une poule pondeuse ?",unit:"En années",answer:8},
{type:"WTF",q:"Nombre de dents d'un escargot ?",unit:"En dents",answer:14000},
{type:"WTF",q:"Vitesse d'un escargot ?",unit:"En km/h",answer:0},
{type:"WTF",q:"Nombre de coeurs d'une pieuvre ?",unit:"En coeurs",answer:3},
{type:"WTF",q:"Nombre de cerveaux d'une pieuvre ?",unit:"En cerveaux",answer:9},
{type:"WTF",q:"Couleur du sang d'une pieuvre ?",unit:"En couleur (bleu=1)",answer:1},
{type:"WTF",q:"Nombre de cils sur un humain ?",unit:"En nombre",answer:50025},
{type:"WTF",q:"Nombre de ongles sur un humain ?",unit:"En nombre",answer:13099},
{type:"WTF",q:"Nombre de poils sur un humain ?",unit:"En nombre",answer:85914},
{type:"WTF",q:"Nombre de cheveux sur un humain ?",unit:"En nombre",answer:56470},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Lyon ?",unit:"En cm",answer:17},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Brest ?",unit:"En cm",answer:26},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Montpellier ?",unit:"En cm",answer:10},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Paris ?",unit:"En cm",answer:28},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Nîmes ?",unit:"En cm",answer:26},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Metz ?",unit:"En cm",answer:30},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Tours ?",unit:"En cm",answer:25},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Nice ?",unit:"En cm",answer:24},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Reims ?",unit:"En cm",answer:28},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Nantes ?",unit:"En cm",answer:15},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Bordeaux ?",unit:"En cm",answer:23},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Toulouse ?",unit:"En cm",answer:16},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Grenoble ?",unit:"En cm",answer:19},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Dijon ?",unit:"En cm",answer:20},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Marseille ?",unit:"En cm",answer:24},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Angers ?",unit:"En cm",answer:25},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Strasbourg ?",unit:"En cm",answer:19},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Amiens ?",unit:"En cm",answer:25},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Rennes ?",unit:"En cm",answer:30},
{type:"WTF",q:"Longueur du plus long poil de nez jamais mesuré à Lille ?",unit:"En cm",answer:27},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 1 - combien de secondes pour faire un tour de terrain à Lyon en 2020 ? (1000) ?",unit:"En secondes",answer:265},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 2 - combien de secondes pour compter jusqu à 100 à Marseille en 2021 ? (1001) ?",unit:"En secondes",answer:173},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 3 - combien de secondes pour faire un tour de terrain à Marseille en 2022 ? (1002) ?",unit:"En secondes",answer:282},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 4 - combien de secondes pour éplucher une banane à Paris en 2023 ? (1003) ?",unit:"En secondes",answer:268},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 5 - combien de secondes pour boire un café à Paris en 2024 ? (1004) ?",unit:"En secondes",answer:95},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 6 - combien de secondes pour faire un tour de terrain à Lyon en 2025 ? (1005) ?",unit:"En secondes",answer:91},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 7 - combien de secondes pour faire un tour de terrain à Marseille en 2026 ? (1006) ?",unit:"En secondes",answer:276},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 8 - combien de secondes pour éplucher une banane à Marseille en 2027 ? (1007) ?",unit:"En secondes",answer:258},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 9 - combien de secondes pour compter jusqu à 100 à Marseille en 2028 ? (1008) ?",unit:"En secondes",answer:157},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 10 - combien de secondes pour compter jusqu à 100 à Marseille en 2029 ? (1009) ?",unit:"En secondes",answer:169},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 11 - combien de secondes pour éplucher une banane à Marseille en 2030 ? (1010) ?",unit:"En secondes",answer:17},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 12 - combien de secondes pour compter jusqu à 100 à Paris en 2031 ? (1011) ?",unit:"En secondes",answer:53},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 13 - combien de secondes pour éplucher une banane à Marseille en 2032 ? (1012) ?",unit:"En secondes",answer:161},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 14 - combien de secondes pour éplucher une banane à Lyon en 2033 ? (1013) ?",unit:"En secondes",answer:151},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 15 - combien de secondes pour éplucher une banane à Lyon en 2034 ? (1014) ?",unit:"En secondes",answer:290},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 16 - combien de secondes pour faire un tour de terrain à Lyon en 2035 ? (1015) ?",unit:"En secondes",answer:118},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 17 - combien de secondes pour boire un café à Marseille en 2036 ? (1016) ?",unit:"En secondes",answer:218},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 18 - combien de secondes pour éplucher une banane à Paris en 2037 ? (1017) ?",unit:"En secondes",answer:214},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 19 - combien de secondes pour compter jusqu à 100 à Paris en 2038 ? (1018) ?",unit:"En secondes",answer:184},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 20 - combien de secondes pour boire un café à Paris en 2039 ? (1019) ?",unit:"En secondes",answer:197},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 21 - combien de secondes pour boire un café à Lyon en 2040 ? (1020) ?",unit:"En secondes",answer:259},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 22 - combien de secondes pour compter jusqu à 100 à Marseille en 2041 ? (1021) ?",unit:"En secondes",answer:150},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 23 - combien de secondes pour faire un tour de terrain à Lyon en 2042 ? (1022) ?",unit:"En secondes",answer:66},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 24 - combien de secondes pour compter jusqu à 100 à Marseille en 2043 ? (1023) ?",unit:"En secondes",answer:184},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 25 - combien de secondes pour compter jusqu à 100 à Lyon en 2044 ? (1024) ?",unit:"En secondes",answer:162},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 26 - combien de secondes pour compter jusqu à 100 à Paris en 2045 ? (1025) ?",unit:"En secondes",answer:183},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 27 - combien de secondes pour faire un tour de terrain à Marseille en 2046 ? (1026) ?",unit:"En secondes",answer:285},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 28 - combien de secondes pour compter jusqu à 100 à Paris en 2047 ? (1027) ?",unit:"En secondes",answer:57},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 29 - combien de secondes pour faire un tour de terrain à Paris en 2048 ? (1028) ?",unit:"En secondes",answer:77},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 30 - combien de secondes pour éplucher une banane à Lyon en 2049 ? (1029) ?",unit:"En secondes",answer:242},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 31 - combien de secondes pour boire un café à Marseille en 2050 ? (1030) ?",unit:"En secondes",answer:206},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 32 - combien de secondes pour éplucher une banane à Lyon en 2051 ? (1031) ?",unit:"En secondes",answer:286},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 33 - combien de secondes pour éplucher une banane à Paris en 2052 ? (1032) ?",unit:"En secondes",answer:44},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 34 - combien de secondes pour compter jusqu à 100 à Lyon en 2053 ? (1033) ?",unit:"En secondes",answer:152},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 35 - combien de secondes pour faire un tour de terrain à Marseille en 2054 ? (1034) ?",unit:"En secondes",answer:233},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 36 - combien de secondes pour boire un café à Paris en 2055 ? (1035) ?",unit:"En secondes",answer:250},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 37 - combien de secondes pour faire un tour de terrain à Paris en 2056 ? (1036) ?",unit:"En secondes",answer:11},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 38 - combien de secondes pour faire un tour de terrain à Paris en 2057 ? (1037) ?",unit:"En secondes",answer:113},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 39 - combien de secondes pour éplucher une banane à Paris en 2058 ? (1038) ?",unit:"En secondes",answer:243},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 40 - combien de secondes pour faire un tour de terrain à Lyon en 2059 ? (1039) ?",unit:"En secondes",answer:271},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 41 - combien de secondes pour boire un café à Paris en 2060 ? (1040) ?",unit:"En secondes",answer:239},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 42 - combien de secondes pour éplucher une banane à Lyon en 2061 ? (1041) ?",unit:"En secondes",answer:97},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 43 - combien de secondes pour compter jusqu à 100 à Lyon en 2062 ? (1042) ?",unit:"En secondes",answer:172},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 44 - combien de secondes pour éplucher une banane à Marseille en 2063 ? (1043) ?",unit:"En secondes",answer:52},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 45 - combien de secondes pour éplucher une banane à Lyon en 2064 ? (1044) ?",unit:"En secondes",answer:139},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 46 - combien de secondes pour boire un café à Lyon en 2065 ? (1045) ?",unit:"En secondes",answer:159},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 47 - combien de secondes pour faire un tour de terrain à Paris en 2066 ? (1046) ?",unit:"En secondes",answer:149},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 48 - combien de secondes pour faire un tour de terrain à Paris en 2067 ? (1047) ?",unit:"En secondes",answer:49},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 49 - combien de secondes pour compter jusqu à 100 à Lyon en 2068 ? (1048) ?",unit:"En secondes",answer:19},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 50 - combien de secondes pour boire un café à Marseille en 2069 ? (1049) ?",unit:"En secondes",answer:274},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 51 - combien de secondes pour éplucher une banane à Marseille en 2070 ? (1050) ?",unit:"En secondes",answer:100},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 52 - combien de secondes pour éplucher une banane à Paris en 2071 ? (1051) ?",unit:"En secondes",answer:291},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 53 - combien de secondes pour faire un tour de terrain à Paris en 2072 ? (1052) ?",unit:"En secondes",answer:179},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 54 - combien de secondes pour boire un café à Paris en 2073 ? (1053) ?",unit:"En secondes",answer:251},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 55 - combien de secondes pour boire un café à Marseille en 2074 ? (1054) ?",unit:"En secondes",answer:101},
{type:"WTF",q:"WTF - Question absurde précise WTF numéro 56 - combien de secondes pour boire un café à Marseille en 2075 ? (1055) ?",unit:"En secondes",answer:128},
{type:"INCONGRU",q:"Nombre de fois où on cligne des yeux par jour ?",unit:"En fois",answer:15000},
{type:"INCONGRU",q:"Nombre de fois où on respire par jour ?",unit:"En fois",answer:20000},
{type:"INCONGRU",q:"Longueur totale des vaisseaux sanguins si mis bout à bout ?",unit:"En km",answer:100000},
{type:"INCONGRU",q:"Poids d'un nuage cumulus moyen ?",unit:"En tonnes",answer:500},
{type:"INCONGRU",q:"Nombre de grains de sable sur Terre (estimation) ?",unit:"En sextillions",answer:7},
{type:"INCONGRU",q:"Nombre de fourmis sur Terre ?",unit:"En quadrillions",answer:20},
{type:"INCONGRU",q:"Masse de toutes les fourmis vs masse de tous les humains ?",unit:"En fois",answer:1},
{type:"INCONGRU",q:"Nombre de feuilles sur un chêne adulte ?",unit:"En milliers",answer:250},
{type:"INCONGRU",q:"Hauteur du plus grand arbre (séquoia Hyperion) ?",unit:"En m",answer:115},
{type:"INCONGRU",q:"Âge du plus vieil arbre (pin Mathusalem) ?",unit:"En années",answer:4850},
{type:"INCONGRU",q:"Vitesse de croissance du bambou record par jour ?",unit:"En cm",answer:91},
{type:"INCONGRU",q:"Nombre de battements de coeur d'une baleine bleue par minute ?",unit:"En battements",answer:6},
{type:"INCONGRU",q:"Pression artérielle d'une girafe ?",unit:"En mmHg",answer:280},
{type:"INCONGRU",q:"Nombre d'oeufs pondus par une poule par an ?",unit:"En oeufs",answer:300},
{type:"INCONGRU",q:"Durée de vie d'une poule pondeuse ?",unit:"En années",answer:8},
{type:"INCONGRU",q:"Nombre de dents d'un escargot ?",unit:"En dents",answer:14000},
{type:"INCONGRU",q:"Vitesse d'un escargot ?",unit:"En km/h",answer:0},
{type:"INCONGRU",q:"Nombre de coeurs d'une pieuvre ?",unit:"En coeurs",answer:3},
{type:"INCONGRU",q:"Nombre de cerveaux d'une pieuvre ?",unit:"En cerveaux",answer:9},
{type:"INCONGRU",q:"Couleur du sang d'une pieuvre ?",unit:"En couleur (bleu=1)",answer:1},
{type:"INCONGRU",q:"Nombre de ongles sur un humain ?",unit:"En nombre",answer:90488},
{type:"INCONGRU",q:"Nombre de cils sur un humain ?",unit:"En nombre",answer:11651},
{type:"INCONGRU",q:"Nombre de cheveux sur un humain ?",unit:"En nombre",answer:57204},
{type:"INCONGRU",q:"Nombre de poils sur un humain ?",unit:"En nombre",answer:51973},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Tours ?",unit:"En grains",answer:48138},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Metz ?",unit:"En grains",answer:55394},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Brest ?",unit:"En grains",answer:55448},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Lille ?",unit:"En grains",answer:46840},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Marseille ?",unit:"En grains",answer:43684},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Amiens ?",unit:"En grains",answer:43381},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Paris ?",unit:"En grains",answer:49931},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Angers ?",unit:"En grains",answer:56750},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Rennes ?",unit:"En grains",answer:50739},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Nîmes ?",unit:"En grains",answer:56403},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Nice ?",unit:"En grains",answer:42707},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Dijon ?",unit:"En grains",answer:43789},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Lyon ?",unit:"En grains",answer:40170},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Bordeaux ?",unit:"En grains",answer:55966},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Grenoble ?",unit:"En grains",answer:54022},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Strasbourg ?",unit:"En grains",answer:50623},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Montpellier ?",unit:"En grains",answer:46697},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Reims ?",unit:"En grains",answer:50106},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Nantes ?",unit:"En grains",answer:43513},
{type:"INCONGRU",q:"Nombre de grains de riz dans un paquet de 1kg à Toulouse ?",unit:"En grains",answer:46960},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 1 - combien de secondes pour faire un tour de terrain à Paris en 2020 ? (1000) ?",unit:"En secondes",answer:37},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 2 - combien de secondes pour compter jusqu à 100 à Paris en 2021 ? (1001) ?",unit:"En secondes",answer:188},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 3 - combien de secondes pour compter jusqu à 100 à Marseille en 2022 ? (1002) ?",unit:"En secondes",answer:206},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 4 - combien de secondes pour éplucher une banane à Marseille en 2023 ? (1003) ?",unit:"En secondes",answer:94},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 5 - combien de secondes pour éplucher une banane à Paris en 2024 ? (1004) ?",unit:"En secondes",answer:16},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 6 - combien de secondes pour faire un tour de terrain à Marseille en 2025 ? (1005) ?",unit:"En secondes",answer:159},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 7 - combien de secondes pour compter jusqu à 100 à Paris en 2026 ? (1006) ?",unit:"En secondes",answer:203},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 8 - combien de secondes pour boire un café à Paris en 2027 ? (1007) ?",unit:"En secondes",answer:204},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 9 - combien de secondes pour faire un tour de terrain à Paris en 2028 ? (1008) ?",unit:"En secondes",answer:192},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 10 - combien de secondes pour compter jusqu à 100 à Paris en 2029 ? (1009) ?",unit:"En secondes",answer:262},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 11 - combien de secondes pour faire un tour de terrain à Paris en 2030 ? (1010) ?",unit:"En secondes",answer:146},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 12 - combien de secondes pour faire un tour de terrain à Paris en 2031 ? (1011) ?",unit:"En secondes",answer:37},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 13 - combien de secondes pour faire un tour de terrain à Lyon en 2032 ? (1012) ?",unit:"En secondes",answer:276},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 14 - combien de secondes pour faire un tour de terrain à Marseille en 2033 ? (1013) ?",unit:"En secondes",answer:23},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 15 - combien de secondes pour compter jusqu à 100 à Lyon en 2034 ? (1014) ?",unit:"En secondes",answer:55},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 16 - combien de secondes pour compter jusqu à 100 à Lyon en 2035 ? (1015) ?",unit:"En secondes",answer:205},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 17 - combien de secondes pour boire un café à Marseille en 2036 ? (1016) ?",unit:"En secondes",answer:211},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 18 - combien de secondes pour éplucher une banane à Paris en 2037 ? (1017) ?",unit:"En secondes",answer:34},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 19 - combien de secondes pour éplucher une banane à Paris en 2038 ? (1018) ?",unit:"En secondes",answer:145},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 20 - combien de secondes pour boire un café à Paris en 2039 ? (1019) ?",unit:"En secondes",answer:254},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 21 - combien de secondes pour compter jusqu à 100 à Marseille en 2040 ? (1020) ?",unit:"En secondes",answer:39},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 22 - combien de secondes pour boire un café à Paris en 2041 ? (1021) ?",unit:"En secondes",answer:73},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 23 - combien de secondes pour compter jusqu à 100 à Marseille en 2042 ? (1022) ?",unit:"En secondes",answer:113},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 24 - combien de secondes pour compter jusqu à 100 à Marseille en 2043 ? (1023) ?",unit:"En secondes",answer:91},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 25 - combien de secondes pour faire un tour de terrain à Lyon en 2044 ? (1024) ?",unit:"En secondes",answer:108},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 26 - combien de secondes pour boire un café à Marseille en 2045 ? (1025) ?",unit:"En secondes",answer:140},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 27 - combien de secondes pour faire un tour de terrain à Lyon en 2046 ? (1026) ?",unit:"En secondes",answer:220},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 28 - combien de secondes pour éplucher une banane à Paris en 2047 ? (1027) ?",unit:"En secondes",answer:47},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 29 - combien de secondes pour faire un tour de terrain à Marseille en 2048 ? (1028) ?",unit:"En secondes",answer:75},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 30 - combien de secondes pour éplucher une banane à Paris en 2049 ? (1029) ?",unit:"En secondes",answer:126},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 31 - combien de secondes pour éplucher une banane à Paris en 2050 ? (1030) ?",unit:"En secondes",answer:86},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 32 - combien de secondes pour compter jusqu à 100 à Paris en 2051 ? (1031) ?",unit:"En secondes",answer:271},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 33 - combien de secondes pour compter jusqu à 100 à Paris en 2052 ? (1032) ?",unit:"En secondes",answer:183},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 34 - combien de secondes pour boire un café à Lyon en 2053 ? (1033) ?",unit:"En secondes",answer:256},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 35 - combien de secondes pour éplucher une banane à Marseille en 2054 ? (1034) ?",unit:"En secondes",answer:132},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 36 - combien de secondes pour faire un tour de terrain à Marseille en 2055 ? (1035) ?",unit:"En secondes",answer:218},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 37 - combien de secondes pour éplucher une banane à Marseille en 2056 ? (1036) ?",unit:"En secondes",answer:106},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 38 - combien de secondes pour boire un café à Paris en 2057 ? (1037) ?",unit:"En secondes",answer:54},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 39 - combien de secondes pour boire un café à Marseille en 2058 ? (1038) ?",unit:"En secondes",answer:250},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 40 - combien de secondes pour éplucher une banane à Marseille en 2059 ? (1039) ?",unit:"En secondes",answer:243},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 41 - combien de secondes pour compter jusqu à 100 à Paris en 2060 ? (1040) ?",unit:"En secondes",answer:241},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 42 - combien de secondes pour éplucher une banane à Paris en 2061 ? (1041) ?",unit:"En secondes",answer:17},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 43 - combien de secondes pour éplucher une banane à Lyon en 2062 ? (1042) ?",unit:"En secondes",answer:186},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 44 - combien de secondes pour compter jusqu à 100 à Marseille en 2063 ? (1043) ?",unit:"En secondes",answer:131},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 45 - combien de secondes pour éplucher une banane à Paris en 2064 ? (1044) ?",unit:"En secondes",answer:112},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 46 - combien de secondes pour éplucher une banane à Paris en 2065 ? (1045) ?",unit:"En secondes",answer:88},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 47 - combien de secondes pour faire un tour de terrain à Lyon en 2066 ? (1046) ?",unit:"En secondes",answer:146},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 48 - combien de secondes pour compter jusqu à 100 à Marseille en 2067 ? (1047) ?",unit:"En secondes",answer:247},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 49 - combien de secondes pour faire un tour de terrain à Lyon en 2068 ? (1048) ?",unit:"En secondes",answer:299},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 50 - combien de secondes pour faire un tour de terrain à Lyon en 2069 ? (1049) ?",unit:"En secondes",answer:188},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 51 - combien de secondes pour compter jusqu à 100 à Marseille en 2070 ? (1050) ?",unit:"En secondes",answer:50},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 52 - combien de secondes pour faire un tour de terrain à Paris en 2071 ? (1051) ?",unit:"En secondes",answer:89},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 53 - combien de secondes pour boire un café à Lyon en 2072 ? (1052) ?",unit:"En secondes",answer:278},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 54 - combien de secondes pour boire un café à Marseille en 2073 ? (1053) ?",unit:"En secondes",answer:295},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 55 - combien de secondes pour éplucher une banane à Marseille en 2074 ? (1054) ?",unit:"En secondes",answer:274},
{type:"INCONGRU",q:"INCONGRU - Question absurde précise INCONGRU numéro 56 - combien de secondes pour faire un tour de terrain à Marseille en 2075 ? (1055) ?",unit:"En secondes",answer:266},
{type:"DÉGUEU",q:"Nombre de fois où on cligne des yeux par jour ?",unit:"En fois",answer:15000},
{type:"DÉGUEU",q:"Nombre de fois où on respire par jour ?",unit:"En fois",answer:20000},
{type:"DÉGUEU",q:"Longueur totale des vaisseaux sanguins si mis bout à bout ?",unit:"En km",answer:100000},
{type:"DÉGUEU",q:"Poids d'un nuage cumulus moyen ?",unit:"En tonnes",answer:500},
{type:"DÉGUEU",q:"Nombre de grains de sable sur Terre (estimation) ?",unit:"En sextillions",answer:7},
{type:"DÉGUEU",q:"Nombre de fourmis sur Terre ?",unit:"En quadrillions",answer:20},
{type:"DÉGUEU",q:"Masse de toutes les fourmis vs masse de tous les humains ?",unit:"En fois",answer:1},
{type:"DÉGUEU",q:"Nombre de feuilles sur un chêne adulte ?",unit:"En milliers",answer:250},
{type:"DÉGUEU",q:"Hauteur du plus grand arbre (séquoia Hyperion) ?",unit:"En m",answer:115},
{type:"DÉGUEU",q:"Âge du plus vieil arbre (pin Mathusalem) ?",unit:"En années",answer:4850},
{type:"DÉGUEU",q:"Vitesse de croissance du bambou record par jour ?",unit:"En cm",answer:91},
{type:"DÉGUEU",q:"Nombre de battements de coeur d'une baleine bleue par minute ?",unit:"En battements",answer:6},
{type:"DÉGUEU",q:"Pression artérielle d'une girafe ?",unit:"En mmHg",answer:280},
{type:"DÉGUEU",q:"Nombre d'oeufs pondus par une poule par an ?",unit:"En oeufs",answer:300},
{type:"DÉGUEU",q:"Durée de vie d'une poule pondeuse ?",unit:"En années",answer:8},
{type:"DÉGUEU",q:"Nombre de dents d'un escargot ?",unit:"En dents",answer:14000},
{type:"DÉGUEU",q:"Vitesse d'un escargot ?",unit:"En km/h",answer:0},
{type:"DÉGUEU",q:"Nombre de coeurs d'une pieuvre ?",unit:"En coeurs",answer:3},
{type:"DÉGUEU",q:"Nombre de cerveaux d'une pieuvre ?",unit:"En cerveaux",answer:9},
{type:"DÉGUEU",q:"Couleur du sang d'une pieuvre ?",unit:"En couleur (bleu=1)",answer:1},
{type:"DÉGUEU",q:"Nombre de cils sur un humain ?",unit:"En nombre",answer:98717},
{type:"DÉGUEU",q:"Nombre de ongles sur un humain ?",unit:"En nombre",answer:30771},
{type:"DÉGUEU",q:"Nombre de cheveux sur un humain ?",unit:"En nombre",answer:40662},
{type:"DÉGUEU",q:"Nombre de poils sur un humain ?",unit:"En nombre",answer:84140},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Montpellier ?",unit:"En milliards",answer:50},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Grenoble ?",unit:"En milliards",answer:27},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Amiens ?",unit:"En milliards",answer:35},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Metz ?",unit:"En milliards",answer:12},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Strasbourg ?",unit:"En milliards",answer:21},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Lille ?",unit:"En milliards",answer:43},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Tours ?",unit:"En milliards",answer:29},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Dijon ?",unit:"En milliards",answer:17},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Bordeaux ?",unit:"En milliards",answer:33},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Marseille ?",unit:"En milliards",answer:31},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Brest ?",unit:"En milliards",answer:10},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Nîmes ?",unit:"En milliards",answer:32},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Angers ?",unit:"En milliards",answer:15},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Nantes ?",unit:"En milliards",answer:37},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Reims ?",unit:"En milliards",answer:40},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Toulouse ?",unit:"En milliards",answer:20},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Nice ?",unit:"En milliards",answer:12},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Rennes ?",unit:"En milliards",answer:26},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Lyon ?",unit:"En milliards",answer:21},
{type:"DÉGUEU",q:"Nombre de bactéries sur une éponge de cuisine à Paris ?",unit:"En milliards",answer:26},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 1 - combien de secondes pour boire un café à Marseille en 2020 ? (1000) ?",unit:"En secondes",answer:74},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 2 - combien de secondes pour faire un tour de terrain à Marseille en 2021 ? (1001) ?",unit:"En secondes",answer:24},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 3 - combien de secondes pour faire un tour de terrain à Marseille en 2022 ? (1002) ?",unit:"En secondes",answer:161},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 4 - combien de secondes pour boire un café à Marseille en 2023 ? (1003) ?",unit:"En secondes",answer:10},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 5 - combien de secondes pour compter jusqu à 100 à Paris en 2024 ? (1004) ?",unit:"En secondes",answer:63},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 6 - combien de secondes pour éplucher une banane à Paris en 2025 ? (1005) ?",unit:"En secondes",answer:197},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 7 - combien de secondes pour compter jusqu à 100 à Lyon en 2026 ? (1006) ?",unit:"En secondes",answer:298},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 8 - combien de secondes pour éplucher une banane à Lyon en 2027 ? (1007) ?",unit:"En secondes",answer:121},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 9 - combien de secondes pour compter jusqu à 100 à Marseille en 2028 ? (1008) ?",unit:"En secondes",answer:85},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 10 - combien de secondes pour faire un tour de terrain à Lyon en 2029 ? (1009) ?",unit:"En secondes",answer:176},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 11 - combien de secondes pour compter jusqu à 100 à Marseille en 2030 ? (1010) ?",unit:"En secondes",answer:288},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 12 - combien de secondes pour boire un café à Paris en 2031 ? (1011) ?",unit:"En secondes",answer:280},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 13 - combien de secondes pour compter jusqu à 100 à Paris en 2032 ? (1012) ?",unit:"En secondes",answer:286},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 14 - combien de secondes pour faire un tour de terrain à Lyon en 2033 ? (1013) ?",unit:"En secondes",answer:220},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 15 - combien de secondes pour faire un tour de terrain à Lyon en 2034 ? (1014) ?",unit:"En secondes",answer:241},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 16 - combien de secondes pour boire un café à Lyon en 2035 ? (1015) ?",unit:"En secondes",answer:189},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 17 - combien de secondes pour compter jusqu à 100 à Paris en 2036 ? (1016) ?",unit:"En secondes",answer:98},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 18 - combien de secondes pour éplucher une banane à Paris en 2037 ? (1017) ?",unit:"En secondes",answer:250},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 19 - combien de secondes pour faire un tour de terrain à Paris en 2038 ? (1018) ?",unit:"En secondes",answer:241},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 20 - combien de secondes pour éplucher une banane à Lyon en 2039 ? (1019) ?",unit:"En secondes",answer:292},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 21 - combien de secondes pour compter jusqu à 100 à Lyon en 2040 ? (1020) ?",unit:"En secondes",answer:288},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 22 - combien de secondes pour éplucher une banane à Lyon en 2041 ? (1021) ?",unit:"En secondes",answer:50},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 23 - combien de secondes pour faire un tour de terrain à Marseille en 2042 ? (1022) ?",unit:"En secondes",answer:143},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 24 - combien de secondes pour boire un café à Paris en 2043 ? (1023) ?",unit:"En secondes",answer:255},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 25 - combien de secondes pour compter jusqu à 100 à Marseille en 2044 ? (1024) ?",unit:"En secondes",answer:69},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 26 - combien de secondes pour boire un café à Marseille en 2045 ? (1025) ?",unit:"En secondes",answer:181},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 27 - combien de secondes pour boire un café à Lyon en 2046 ? (1026) ?",unit:"En secondes",answer:241},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 28 - combien de secondes pour boire un café à Lyon en 2047 ? (1027) ?",unit:"En secondes",answer:86},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 29 - combien de secondes pour boire un café à Marseille en 2048 ? (1028) ?",unit:"En secondes",answer:189},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 30 - combien de secondes pour éplucher une banane à Marseille en 2049 ? (1029) ?",unit:"En secondes",answer:154},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 31 - combien de secondes pour faire un tour de terrain à Marseille en 2050 ? (1030) ?",unit:"En secondes",answer:60},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 32 - combien de secondes pour éplucher une banane à Marseille en 2051 ? (1031) ?",unit:"En secondes",answer:118},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 33 - combien de secondes pour boire un café à Marseille en 2052 ? (1032) ?",unit:"En secondes",answer:80},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 34 - combien de secondes pour éplucher une banane à Marseille en 2053 ? (1033) ?",unit:"En secondes",answer:226},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 35 - combien de secondes pour faire un tour de terrain à Lyon en 2054 ? (1034) ?",unit:"En secondes",answer:63},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 36 - combien de secondes pour boire un café à Marseille en 2055 ? (1035) ?",unit:"En secondes",answer:26},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 37 - combien de secondes pour faire un tour de terrain à Paris en 2056 ? (1036) ?",unit:"En secondes",answer:45},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 38 - combien de secondes pour compter jusqu à 100 à Paris en 2057 ? (1037) ?",unit:"En secondes",answer:24},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 39 - combien de secondes pour faire un tour de terrain à Marseille en 2058 ? (1038) ?",unit:"En secondes",answer:13},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 40 - combien de secondes pour éplucher une banane à Marseille en 2059 ? (1039) ?",unit:"En secondes",answer:152},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 41 - combien de secondes pour compter jusqu à 100 à Marseille en 2060 ? (1040) ?",unit:"En secondes",answer:22},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 42 - combien de secondes pour éplucher une banane à Paris en 2061 ? (1041) ?",unit:"En secondes",answer:225},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 43 - combien de secondes pour faire un tour de terrain à Lyon en 2062 ? (1042) ?",unit:"En secondes",answer:150},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 44 - combien de secondes pour compter jusqu à 100 à Marseille en 2063 ? (1043) ?",unit:"En secondes",answer:221},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 45 - combien de secondes pour boire un café à Paris en 2064 ? (1044) ?",unit:"En secondes",answer:168},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 46 - combien de secondes pour faire un tour de terrain à Lyon en 2065 ? (1045) ?",unit:"En secondes",answer:110},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 47 - combien de secondes pour éplucher une banane à Lyon en 2066 ? (1046) ?",unit:"En secondes",answer:39},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 48 - combien de secondes pour boire un café à Paris en 2067 ? (1047) ?",unit:"En secondes",answer:126},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 49 - combien de secondes pour faire un tour de terrain à Lyon en 2068 ? (1048) ?",unit:"En secondes",answer:250},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 50 - combien de secondes pour faire un tour de terrain à Lyon en 2069 ? (1049) ?",unit:"En secondes",answer:33},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 51 - combien de secondes pour éplucher une banane à Marseille en 2070 ? (1050) ?",unit:"En secondes",answer:73},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 52 - combien de secondes pour boire un café à Lyon en 2071 ? (1051) ?",unit:"En secondes",answer:187},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 53 - combien de secondes pour éplucher une banane à Marseille en 2072 ? (1052) ?",unit:"En secondes",answer:221},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 54 - combien de secondes pour éplucher une banane à Lyon en 2073 ? (1053) ?",unit:"En secondes",answer:204},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 55 - combien de secondes pour faire un tour de terrain à Lyon en 2074 ? (1054) ?",unit:"En secondes",answer:116},
{type:"DÉGUEU",q:"DÉGUEU - Question absurde précise DÉGUEU numéro 56 - combien de secondes pour faire un tour de terrain à Marseille en 2075 ? (1055) ?",unit:"En secondes",answer:28},
{type:"IMPOSSIBLE",q:"Distance moyenne entre la Terre et la Lune ?",unit:"En km",answer:384400},
{type:"IMPOSSIBLE",q:"Distance moyenne entre la Terre et le Soleil ?",unit:"En millions de km",answer:150},
{type:"IMPOSSIBLE",q:"Vitesse de la lumière dans le vide ?",unit:"En km/s",answer:299792},
{type:"IMPOSSIBLE",q:"Âge estimé de l'Univers ?",unit:"En milliards d'années",answer:14},
{type:"IMPOSSIBLE",q:"Nombre estimé de galaxies dans l'univers observable ?",unit:"En milliards",answer:2000},
{type:"IMPOSSIBLE",q:"Nombre d'étoiles dans la Voie Lactée ?",unit:"En milliards",answer:200},
{type:"IMPOSSIBLE",q:"Diamètre de la Voie Lactée ?",unit:"En années-lumière",answer:100000},
{type:"IMPOSSIBLE",q:"Température à la surface du Soleil ?",unit:"En °C",answer:5500},
{type:"IMPOSSIBLE",q:"Température au centre du Soleil ?",unit:"En millions de °C",answer:15},
{type:"IMPOSSIBLE",q:"Distance de Proxima du Centaure, l'étoile la plus proche ?",unit:"En années-lumière",answer:4},
{type:"IMPOSSIBLE",q:"Temps que met la lumière du Soleil pour arriver sur Terre ?",unit:"En minutes",answer:8},
{type:"IMPOSSIBLE",q:"Diamètre de Jupiter ?",unit:"En km",answer:139820},
{type:"IMPOSSIBLE",q:"Nombre de lunes de Saturne connues en 2024 ?",unit:"En lunes",answer:146},
{type:"IMPOSSIBLE",q:"Masse du Soleil par rapport à la Terre ?",unit:"En fois la Terre",answer:333000},
{type:"IMPOSSIBLE",q:"Vitesse orbitale de l'ISS ?",unit:"En km/h",answer:27600},
{type:"IMPOSSIBLE",q:"Altitude moyenne de l'ISS ?",unit:"En km",answer:400},
{type:"IMPOSSIBLE",q:"Diamètre du trou noir TON 618 ?",unit:"En milliards de km",answer:390},
{type:"IMPOSSIBLE",q:"Masse de TON 618 en masses solaires ?",unit:"En milliards",answer:66},
{type:"IMPOSSIBLE",q:"Une année-lumière en milliards de km ?",unit:"En milliards de km",answer:9461},
{type:"IMPOSSIBLE",q:"Diamètre du Soleil ?",unit:"En km",answer:1392700},
{type:"IMPOSSIBLE",q:"Nombre de planètes dans le système solaire ?",unit:"En planètes",answer:8},
{type:"IMPOSSIBLE",q:"Durée d'une année sur Mercure ?",unit:"En jours terrestres",answer:88},
{type:"IMPOSSIBLE",q:"Durée d'une année sur Mars ?",unit:"En jours terrestres",answer:687},
{type:"IMPOSSIBLE",q:"Pression atmosphérique sur Mars vs Terre ?",unit:"En % de la Terre",answer:1},
{type:"IMPOSSIBLE",q:"Nombre de lunes de Jupiter ?",unit:"En lunes",answer:95},
{type:"IMPOSSIBLE",q:"Distance Voyager 1 de la Terre en 2024 ?",unit:"En milliards de km",answer:24},
{type:"IMPOSSIBLE",q:"Vitesse de Voyager 1 ?",unit:"En km/h",answer:61000},
{type:"IMPOSSIBLE",q:"Âge de la Terre ?",unit:"En milliards d'années",answer:4},
{type:"IMPOSSIBLE",q:"Profondeur de la fosse des Mariannes ?",unit:"En m",answer:10925},
{type:"IMPOSSIBLE",q:"Hauteur de l'Everest ?",unit:"En m",answer:8848},
{type:"IMPOSSIBLE",q:"Longueur de l'équateur terrestre ?",unit:"En km",answer:40075},
{type:"IMPOSSIBLE",q:"Circonférence de la Lune ?",unit:"En km",answer:10921},
{type:"IMPOSSIBLE",q:"Diamètre de Mars ?",unit:"En km",answer:6779},
{type:"IMPOSSIBLE",q:"Diamètre de Vénus ?",unit:"En km",answer:12104},
{type:"IMPOSSIBLE",q:"Température à la surface de Vénus ?",unit:"En °C",answer:462},
{type:"IMPOSSIBLE",q:"Nombre d'anneaux principaux de Saturne ?",unit:"En anneaux",answer:7},
{type:"IMPOSSIBLE",q:"Durée d'un jour sur Jupiter ?",unit:"En heures",answer:10},
{type:"IMPOSSIBLE",q:"Masse de la Terre ?",unit:"En kg (x10^24)",answer:6},
{type:"IMPOSSIBLE",q:"Masse de Jupiter ?",unit:"En fois la Terre",answer:318},
{type:"IMPOSSIBLE",q:"Distance entre la Terre et Mars au plus proche ?",unit:"En millions de km",answer:55},
{type:"IMPOSSIBLE",q:"Nombre d'étoiles dans l'univers observable ?",unit:"En sextillions",answer:1},
{type:"IMPOSSIBLE",q:"Taille de l'univers observable ?",unit:"En milliards d'années-lumière",answer:93},
{type:"IMPOSSIBLE",q:"Vitesse de rotation de la Terre à l'équateur ?",unit:"En km/h",answer:1670},
{type:"IMPOSSIBLE",q:"Inclinaison de l'axe de la Terre ?",unit:"En degrés",answer:23},
{type:"IMPOSSIBLE",q:"Nombre de galaxies dans le Groupe Local ?",unit:"En galaxies",answer:54},
{type:"IMPOSSIBLE",q:"Distance d'Andromède ?",unit:"En millions d'années-lumière",answer:2},
{type:"IMPOSSIBLE",q:"Masse d'un trou noir stellaire moyen ?",unit:"En masses solaires",answer:10},
{type:"IMPOSSIBLE",q:"Température du fond diffus cosmologique ?",unit:"En K",answer:3},
{type:"IMPOSSIBLE",q:"Âge du Soleil ?",unit:"En milliards d'années",answer:5},
{type:"IMPOSSIBLE",q:"Durée de vie restante du Soleil ?",unit:"En milliards d'années",answer:5},
{type:"IMPOSSIBLE",q:"Nombre de comètes dans le nuage d'Oort ?",unit:"En milliards",answer:1000},
{type:"IMPOSSIBLE",q:"Taille du plus gros astéroïde Cérès ?",unit:"En km",answer:940},
{type:"IMPOSSIBLE",q:"Vitesse de libération de la Terre ?",unit:"En km/s",answer:11},
{type:"IMPOSSIBLE",q:"Énergie libérée par le Soleil par seconde ?",unit:"En x10^26 joules",answer:4},
{type:"IMPOSSIBLE",q:"Nombre de photons émis par le Soleil par seconde ?",unit:"En x10^44",answer:10},
{type:"IMPOSSIBLE",q:"Distance du centre de la Voie Lactée au Soleil ?",unit:"En années-lumière",answer:26000},
{type:"IMPOSSIBLE",q:"Masse du trou noir central de la Voie Lactée ?",unit:"En millions de masses solaires",answer:4},
{type:"IMPOSSIBLE",q:"Nombre de bras spiraux de la Voie Lactée ?",unit:"En bras",answer:4},
{type:"IMPOSSIBLE",q:"Vitesse du Soleil autour du centre galactique ?",unit:"En km/s",answer:230},
{type:"IMPOSSIBLE",q:"Temps pour faire le tour de la galaxie (année galactique) ?",unit:"En millions d'années",answer:230},
{type:"IMPOSSIBLE",q:"Nombre de systèmes planétaires dans la Voie Lactée ?",unit:"En milliards",answer:100},
{type:"IMPOSSIBLE",q:"Probabilité estimée de vie ailleurs ?",unit:"En % (Drake)",answer:50},
{type:"IMPOSSIBLE",q:"Nombre d'atomes dans l'univers observable ?",unit:"En x10^80",answer:1},
{type:"IMPOSSIBLE",q:"Densité moyenne de l'univers ?",unit:"En atomes/m3",answer:1},
{type:"IMPOSSIBLE",q:"Température au centre de la Terre ?",unit:"En °C",answer:6000},
{type:"IMPOSSIBLE",q:"Pression au centre de la Terre ?",unit:"En millions d'atmosphères",answer:3},
{type:"IMPOSSIBLE",q:"Âge des plus vieilles roches terrestres ?",unit:"En milliards d'années",answer:4},
{type:"IMPOSSIBLE",q:"Nombre d'extinctions de masse ?",unit:"En extinctions",answer:5},
{type:"IMPOSSIBLE",q:"Durée d'un jour il y a 1 milliard d'années ?",unit:"En heures",answer:18},
{type:"IMPOSSIBLE",q:"Distance à laquelle la Lune s'éloigne par an ?",unit:"En cm",answer:4},
{type:"IMPOSSIBLE",q:"Nombre de marées par jour ?",unit:"En marées",answer:2},
{type:"IMPOSSIBLE",q:"Hauteur maximale d'une marée (Baie de Fundy) ?",unit:"En m",answer:16},
{type:"IMPOSSIBLE",q:"Vitesse d'un tsunami en haute mer ?",unit:"En km/h",answer:800},
{type:"IMPOSSIBLE",q:"Énergie d'un ouragan catégorie 5 ?",unit:"En bombes d'Hiroshima",answer:10000},
{type:"IMPOSSIBLE",q:"Température la plus chaude enregistrée sur Terre ?",unit:"En °C",answer:57},
{type:"IMPOSSIBLE",q:"Profondeur moyenne des océans ?",unit:"En m",answer:3700},
{type:"IMPOSSIBLE",q:"Volume total d'eau sur Terre ?",unit:"En milliards de km3",answer:1},
{type:"IMPOSSIBLE",q:"Pourcentage d'eau douce sur Terre ?",unit:"En %",answer:3},
{type:"IMPOSSIBLE",q:"Nombre d'espèces animales connues ?",unit:"En millions",answer:2},
{type:"IMPOSSIBLE",q:"Nombre total d'espèces estimées sur Terre ?",unit:"En millions",answer:9},
{type:"IMPOSSIBLE",q:"Masse de tous les humains ?",unit:"En millions de tonnes",answer:400},
{type:"IMPOSSIBLE",q:"Masse de toutes les fourmis ?",unit:"En millions de tonnes",answer:12},
{type:"IMPOSSIBLE",q:"Nombre de fourmis sur Terre ?",unit:"En quadrillions",answer:20},
{type:"IMPOSSIBLE",q:"Nombre de grains de sable sur Terre ?",unit:"En sextillions",answer:7},
{type:"IMPOSSIBLE",q:"Nombre de feuilles sur un chêne adulte ?",unit:"En milliers",answer:250},
{type:"IMPOSSIBLE",q:"Hauteur du plus grand arbre (séquoia) ?",unit:"En m",answer:115},
{type:"IMPOSSIBLE",q:"Âge du plus vieil arbre (Mathusalem) ?",unit:"En années",answer:4850},
{type:"IMPOSSIBLE",q:"Profondeur maximale d'une racine ?",unit:"En m",answer:120},
{type:"IMPOSSIBLE",q:"Vitesse de croissance du bambou record ?",unit:"En cm/jour",answer:91},
{type:"IMPOSSIBLE",q:"Nombre de battements de coeur d'une baleine bleue par minute ?",unit:"En battements",answer:6},
{type:"IMPOSSIBLE",q:"Pression artérielle d'une girafe ?",unit:"En mmHg",answer:280},
{type:"IMPOSSIBLE",q:"Nombre d'oeufs pondus par une poule par an ?",unit:"En oeufs",answer:300},
{type:"IMPOSSIBLE",q:"Durée de vie d'une tortue géante ?",unit:"En années",answer:175},
{type:"IMPOSSIBLE",q:"Vitesse d'un guépard ?",unit:"En km/h",answer:110},
{type:"IMPOSSIBLE",q:"Altitude maximale d'un oiseau (vautour) ?",unit:"En m",answer:11300},
{type:"IMPOSSIBLE",q:"Profondeur de plongée d'un cachalot ?",unit:"En m",answer:2250},
{type:"IMPOSSIBLE",q:"Nombre de neurones dans le cerveau humain ?",unit:"En milliards",answer:86},
{type:"IMPOSSIBLE",q:"Vitesse d'un influx nerveux ?",unit:"En km/h",answer:400},
{type:"IMPOSSIBLE",q:"Distance moyenne entre la Terre et Mars au plus proche ?",unit:"En millions de km",answer:55},
{type:"IMPOSSIBLE",q:"Distance moyenne entre la Terre et Mars au plus proche ? (2013) ?",unit:"En millions de km",answer:55}
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