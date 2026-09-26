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
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = (process.env.DISCORD_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`).trim();
const ANIMATOR_ID = String(process.env.ANIMATOR_ID || '1425928135832109198').trim();
const DISCORD_INVITE_URL = (process.env.DISCORD_INVITE_URL || process.env.INVITE_DISCORD_URL || 'https://discord.gg/TON-INVITE').trim();
if (!CLIENT_ID || !CLIENT_SECRET) console.warn('DISCORD_CLIENT_ID / SECRET manquant');
const SESSION_SECRET = process.env.SESSION_SECRET || (CLIENT_SECRET ? crypto.createHash('sha256').update('ap-session:' + CLIENT_SECRET).digest('hex') : crypto.randomBytes(32).toString('hex'));
const SESSION_MAX_AGE_MS = 7*24*60*60*1000;
function signSession(user){const p=Buffer.from(JSON.stringify({id:String(user.id),username:String(user.username||'joueur'),avatar:user.avatar||null,exp:Date.now()+SESSION_MAX_AGE_MS})).toString('base64url');const s=crypto.createHmac('sha256',SESSION_SECRET).update(p).digest('base64url');return p+'.'+s;}
function verifySession(t){if(typeof t!=='string')return null;const d=t.indexOf('.');if(d<1)return null;const pay=t.slice(0,d);const sig=Buffer.from(t.slice(d+1));const exp=Buffer.from(crypto.createHmac('sha256',SESSION_SECRET).update(pay).digest('base64url'));if(sig.length!==exp.length||!crypto.timingSafeEqual(sig,exp))return null;try{const o=JSON.parse(Buffer.from(pay,'base64url').toString('utf8'));if(!o||!o.id||typeof o.exp!=='number'||o.exp<Date.now())return null;return{id:String(o.id),username:String(o.username||'joueur'),avatar:o.avatar||null};}catch{return null;}}
function parseCookieHeader(h){const out={};if(!h)return out;h.split(';').forEach(part=>{const i=part.indexOf('=');if(i<0)return;const k=part.slice(0,i).trim();let v=part.slice(i+1).trim();if(v.startsWith('"')&&v.endsWith('"'))v=v.slice(1,-1);try{out[k]=decodeURIComponent(v);}catch{out[k]=v;}});return out;}
const isAnimatorUser=u=>!!u&&String(u.id).trim()===ANIMATOR_ID;
app.set('trust proxy',1);app.use(cookieParser());app.use(express.json({limit:'10kb'}));
app.get(['/', '/index.html'],(req,res)=>{res.set('Cache-Control','no-cache');res.sendFile(path.join(__dirname,'index.html'));});

const QUESTIONS_BANK = [
  {
    "type": "PRIX",
    "q": "Un café allongé en terrasse à Paris ?",
    "unit": "En €",
    "answer": 3
  },
  {
    "type": "PRIX",
    "q": "Une baguette tradition chez un artisan ?",
    "unit": "En €",
    "answer": 2
  },
  {
    "type": "PRIX",
    "q": "Un ticket de métro T+ à Paris ?",
    "unit": "En €",
    "answer": 2.5
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
    "q": "Un abonnement Spotify par mois ?",
    "unit": "En €",
    "answer": 11
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
    "q": "Une coupe homme chez un barber à Paris ?",
    "unit": "En €",
    "answer": 25
  },
  {
    "type": "PRIX",
    "q": "Un abonnement Basic-Fit par mois ?",
    "unit": "En €",
    "answer": 26
  },
  {
    "type": "PRIX",
    "q": "Des AirPods Pro 2 ?",
    "unit": "En €",
    "answer": 279
  },
  {
    "type": "PRIX",
    "q": "Un kebab complet avec frites ?",
    "unit": "En €",
    "answer": 8
  },
  {
    "type": "PRIX",
    "q": "Une pizza Margherita 30cm à emporter ?",
    "unit": "En €",
    "answer": 9
  },
  {
    "type": "PRIX",
    "q": "Un sandwich jambon-beurre à Paris ?",
    "unit": "En €",
    "answer": 6
  },
  {
    "type": "PRIX",
    "q": "Un menu Best Of Big Mac ?",
    "unit": "En €",
    "answer": 9
  },
  {
    "type": "PRIX",
    "q": "Un croissant pur beurre en boulangerie ?",
    "unit": "En €",
    "answer": 1.3
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
    "q": "Un Happy Meal McDo ?",
    "unit": "En €",
    "answer": 5
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
    "q": "Poids moyen d'un homme adulte en France ?",
    "unit": "En kg",
    "answer": 81
  },
  {
    "type": "POIDS",
    "q": "Poids d'un bébé à la naissance ?",
    "unit": "En kg",
    "answer": 3.3
  },
  {
    "type": "POIDS",
    "q": "Poids d'un vélo électrique moyen ?",
    "unit": "En kg",
    "answer": 24
  },
  {
    "type": "POIDS",
    "q": "Poids d'un ballon de foot ?",
    "unit": "En g",
    "answer": 430
  },
  {
    "type": "POIDS",
    "q": "Poids d'une bouteille d'eau 1,5L pleine ?",
    "unit": "En kg",
    "answer": 1.5
  },
  {
    "type": "POIDS",
    "q": "Poids d'un MacBook Pro 14 pouces ?",
    "unit": "En kg",
    "answer": 1.6
  },
  {
    "type": "POIDS",
    "q": "Poids d'un berger allemand ?",
    "unit": "En kg",
    "answer": 35
  },
  {
    "type": "POIDS",
    "q": "Poids d'un grizzli mâle ?",
    "unit": "En kg",
    "answer": 350
  },
  {
    "type": "POIDS",
    "q": "Poids d'une vache laitière ?",
    "unit": "En kg",
    "answer": 700
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
    "q": "Distance d'un marathon ?",
    "unit": "En km",
    "answer": 42
  },
  {
    "type": "DISTANCE",
    "q": "Longueur du périphérique parisien ?",
    "unit": "En km",
    "answer": 35
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
    "q": "Distance Terre - Lune ?",
    "unit": "En km",
    "answer": 384400
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
    "q": "Longueur d'une piscine olympique ?",
    "unit": "En m",
    "answer": 50
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur du Mont Blanc ?",
    "unit": "En m",
    "answer": 4808
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur d'un panier de basket NBA ?",
    "unit": "En m",
    "answer": 3.05
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
    "q": "Hauteur de la Burj Khalifa ?",
    "unit": "En m",
    "answer": 828
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur de la pyramide de Khéops ?",
    "unit": "En m",
    "answer": 138
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un Airbus A380 ?",
    "unit": "En m",
    "answer": 72
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une feuille A4 ?",
    "unit": "En cm",
    "answer": 29.7
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
    "q": "Durée d'un vol Paris - New York ?",
    "unit": "En heures",
    "answer": 8
  },
  {
    "type": "TEMPS",
    "q": "Temps pour cuire une pizza au four ?",
    "unit": "En minutes",
    "answer": 12
  },
  {
    "type": "TEMPS",
    "q": "Temps de cuisson des pâtes al dente ?",
    "unit": "En minutes",
    "answer": 9
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
    "q": "Durée d'un trajet Paris - Marseille en TGV ?",
    "unit": "En heures",
    "answer": 3.5
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
    "type": "CULTURE",
    "q": "Année de sortie du premier iPhone ?",
    "unit": "En année",
    "answer": 2007
  },
  {
    "type": "CULTURE",
    "q": "Année de création de Google ?",
    "unit": "En année",
    "answer": 1998
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
    "q": "Année de sortie du premier Star Wars ?",
    "unit": "En année",
    "answer": 1977
  },
  {
    "type": "CULTURE",
    "q": "Nombre de saisons de Friends ?",
    "unit": "En saisons",
    "answer": 10
  },
  {
    "type": "CULTURE",
    "q": "Nombre de saisons de Breaking Bad ?",
    "unit": "En saisons",
    "answer": 5
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
    "q": "Nombre de départements en France ?",
    "unit": "En départements",
    "answer": 101
  },
  {
    "type": "CULTURE",
    "q": "Nombre de régions en France ?",
    "unit": "En régions",
    "answer": 18
  },
  {
    "type": "CULTURE",
    "q": "Nombre d'arrondissements à Paris ?",
    "unit": "En arrondissements",
    "answer": 20
  },
  {
    "type": "CORPS",
    "q": "Combien d'os possède un adulte ?",
    "unit": "En os",
    "answer": 206
  },
  {
    "type": "CORPS",
    "q": "Combien de dents possède un adulte avec dents de sagesse ?",
    "unit": "En dents",
    "answer": 32
  },
  {
    "type": "CORPS",
    "q": "Combien de fois ton coeur bat-il par jour en moyenne ?",
    "unit": "En battements",
    "answer": 100000
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
    "q": "Nombre de chromosomes ?",
    "unit": "En chromosomes",
    "answer": 46
  },
  {
    "type": "CORPS",
    "q": "Température corporelle normale ?",
    "unit": "En °C",
    "answer": 37
  },
  {
    "type": "CORPS",
    "q": "Nombre de muscles pour sourire ?",
    "unit": "En muscles",
    "answer": 17
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse de pointe d'un guépard ?",
    "unit": "En km/h",
    "answer": 110
  },
  {
    "type": "ANIMAL",
    "q": "Durée de vie d'une tortue géante ?",
    "unit": "En années",
    "answer": 150
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
    "answer": 3.5
  },
  {
    "type": "ANIMAL",
    "q": "Profondeur de plongée d'un cachalot ?",
    "unit": "En m",
    "answer": 2250
  },
  {
    "type": "ANIMAL",
    "q": "Nombre de coeurs d'une pieuvre ?",
    "unit": "En coeurs",
    "answer": 3
  },
  {
    "type": "ANIMAL",
    "q": "Nombre de dents d'un escargot ?",
    "unit": "En dents",
    "answer": 14000
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse d'un escargot ?",
    "unit": "En m/h",
    "answer": 48
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de communes en France ?",
    "unit": "En communes",
    "answer": 35000
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de joueurs dans une équipe de foot sur le terrain ?",
    "unit": "En joueurs",
    "answer": 11
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de cases sur un échiquier ?",
    "unit": "En cases",
    "answer": 64
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de jours fériés en France ?",
    "unit": "En jours",
    "answer": 11
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de touches sur un piano standard ?",
    "unit": "En touches",
    "answer": 88
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de côtés d'un hexagone ?",
    "unit": "En côtés",
    "answer": 6
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de minutes dans une heure ?",
    "unit": "En minutes",
    "answer": 60
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de ponts à Paris ?",
    "unit": "En ponts",
    "answer": 37
  },
  {
    "type": "PRIX",
    "q": "Un abonnement Navigo toutes zones par mois ?",
    "unit": "En €",
    "answer": 88.8
  },
  {
    "type": "PRIX",
    "q": "Un kilo de poulet fermier Label Rouge ?",
    "unit": "En €",
    "answer": 12
  },
  {
    "type": "PRIX",
    "q": "Un kilo de tomates en supermarché en été ?",
    "unit": "En €",
    "answer": 3.5
  },
  {
    "type": "PRIX",
    "q": "Un litre de lait demi-écrémé ?",
    "unit": "En €",
    "answer": 1.2
  },
  {
    "type": "PRIX",
    "q": "Un pack de 6 bouteilles d'Evian 1,5L ?",
    "unit": "En €",
    "answer": 4.5
  },
  {
    "type": "PRIX",
    "q": "Une baguette de pain + un croissant + un café ?",
    "unit": "En €",
    "answer": 5.5
  },
  {
    "type": "PRIX",
    "q": "Une manette PS5 DualSense ?",
    "unit": "En €",
    "answer": 70
  },
  {
    "type": "PRIX",
    "q": "Un abonnement YouTube Premium par mois ?",
    "unit": "En €",
    "answer": 14
  },
  {
    "type": "PRIX",
    "q": "Un plein 40L de Gazole ?",
    "unit": "En €",
    "answer": 75
  },
  {
    "type": "PRIX",
    "q": "Un ticket de cinéma UGC avec carte abonnement ?",
    "unit": "En €",
    "answer": 6.5
  },
  {
    "type": "PRIX",
    "q": "Une entrée au Louvre plein tarif ?",
    "unit": "En €",
    "answer": 22
  },
  {
    "type": "PRIX",
    "q": "Un Big Mac seul ?",
    "unit": "En €",
    "answer": 5.2
  },
  {
    "type": "PRIX",
    "q": "Un kilo de saumon fumé ?",
    "unit": "En €",
    "answer": 45
  },
  {
    "type": "PRIX",
    "q": "Un paquet de 20 cigarettes Marlboro ?",
    "unit": "En €",
    "answer": 12.5
  },
  {
    "type": "PRIX",
    "q": "Un abonnement ChatGPT Plus ?",
    "unit": "En €",
    "answer": 20
  },
  {
    "type": "POIDS",
    "q": "Poids d'une boule de bowling réglementaire ?",
    "unit": "En kg",
    "answer": 7.2
  },
  {
    "type": "POIDS",
    "q": "Poids d'un cheval de course moyen ?",
    "unit": "En kg",
    "answer": 500
  },
  {
    "type": "POIDS",
    "q": "Poids d'un piano à queue de concert ?",
    "unit": "En kg",
    "answer": 480
  },
  {
    "type": "POIDS",
    "q": "Poids d'un frigo américain vide ?",
    "unit": "En kg",
    "answer": 110
  },
  {
    "type": "POIDS",
    "q": "Poids d'une pastèque moyenne ?",
    "unit": "En kg",
    "answer": 5
  },
  {
    "type": "POIDS",
    "q": "Poids d'un Airbus A320 à vide ?",
    "unit": "En kg",
    "answer": 42000
  },
  {
    "type": "POIDS",
    "q": "Poids d'une moto GP ?",
    "unit": "En kg",
    "answer": 157
  },
  {
    "type": "POIDS",
    "q": "Poids d'un casque de F1 ?",
    "unit": "En kg",
    "answer": 1.2
  },
  {
    "type": "POIDS",
    "q": "Poids d'un gorille mâle dos argenté ?",
    "unit": "En kg",
    "answer": 180
  },
  {
    "type": "POIDS",
    "q": "Poids d'un iPad Pro 12,9 pouces ?",
    "unit": "En kg",
    "answer": 0.68
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Amsterdam ?",
    "unit": "En km",
    "answer": 510
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Barcelone ?",
    "unit": "En km",
    "answer": 1035
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
    "answer": 1420
  },
  {
    "type": "DISTANCE",
    "q": "Longueur de la Seine ?",
    "unit": "En km",
    "answer": 775
  },
  {
    "type": "DISTANCE",
    "q": "Longueur du Canal du Midi ?",
    "unit": "En km",
    "answer": 240
  },
  {
    "type": "DISTANCE",
    "q": "Tour de la Terre à l'équateur ?",
    "unit": "En km",
    "answer": 40075
  },
  {
    "type": "DISTANCE",
    "q": "Distance Paris - Le Havre ?",
    "unit": "En km",
    "answer": 200
  },
  {
    "type": "DISTANCE",
    "q": "Distance Calais - Douvres à vol d'oiseau ?",
    "unit": "En km",
    "answer": 34
  },
  {
    "type": "DISTANCE",
    "q": "Distance Lyon - Marseille ?",
    "unit": "En km",
    "answer": 315
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur de l'Arc de Triomphe ?",
    "unit": "En m",
    "answer": 50
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur de Notre-Dame de Paris (flèche) ?",
    "unit": "En m",
    "answer": 96
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un bus articulé RATP ?",
    "unit": "En m",
    "answer": 18
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'un porte-avions Charles de Gaulle ?",
    "unit": "En m",
    "answer": 261
  },
  {
    "type": "LONGUEUR",
    "q": "Hauteur du viaduc de Millau (pylône) ?",
    "unit": "En m",
    "answer": 343
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur d'une guitare électrique standard ?",
    "unit": "En m",
    "answer": 1
  },
  {
    "type": "LONGUEUR",
    "q": "Taille moyenne d'un homme en France ?",
    "unit": "En cm",
    "answer": 175
  },
  {
    "type": "LONGUEUR",
    "q": "Diamètre d'un ballon de basket ?",
    "unit": "En cm",
    "answer": 24
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur du Nil ?",
    "unit": "En km",
    "answer": 6650
  },
  {
    "type": "LONGUEUR",
    "q": "Longueur de la Grande Muraille de Chine ?",
    "unit": "En km",
    "answer": 21196
  },
  {
    "type": "POPULATION",
    "q": "Population de la France ?",
    "unit": "En millions",
    "answer": 68
  },
  {
    "type": "POPULATION",
    "q": "Population de l'Allemagne ?",
    "unit": "En millions",
    "answer": 84
  },
  {
    "type": "POPULATION",
    "q": "Population de Tokyo (intra-muros) ?",
    "unit": "En millions",
    "answer": 14
  },
  {
    "type": "POPULATION",
    "q": "Population de New York City ?",
    "unit": "En millions",
    "answer": 8.5
  },
  {
    "type": "POPULATION",
    "q": "Population de Londres ?",
    "unit": "En millions",
    "answer": 9
  },
  {
    "type": "POPULATION",
    "q": "Population de la Belgique ?",
    "unit": "En millions",
    "answer": 11.7
  },
  {
    "type": "POPULATION",
    "q": "Population de Rennes ?",
    "unit": "En habitants",
    "answer": 220000
  },
  {
    "type": "POPULATION",
    "q": "Population de Grenoble ?",
    "unit": "En habitants",
    "answer": 158000
  },
  {
    "type": "POPULATION",
    "q": "Population de la Suisse ?",
    "unit": "En millions",
    "answer": 8.8
  },
  {
    "type": "POPULATION",
    "q": "Population de l'Espagne ?",
    "unit": "En millions",
    "answer": 47
  },
  {
    "type": "TEMPS",
    "q": "Durée du film Avatar 1 ?",
    "unit": "En minutes",
    "answer": 162
  },
  {
    "type": "TEMPS",
    "q": "Durée du film Le Seigneur des Anneaux 1 version longue ?",
    "unit": "En minutes",
    "answer": 228
  },
  {
    "type": "TEMPS",
    "q": "Temps de cuisson d'un riz blanc ?",
    "unit": "En minutes",
    "answer": 11
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un set au tennis sans tie-break max ?",
    "unit": "En minutes",
    "answer": 60
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un concert moyen ?",
    "unit": "En minutes",
    "answer": 120
  },
  {
    "type": "TEMPS",
    "q": "Durée de vie moyenne d'un iPhone utilisé ?",
    "unit": "En années",
    "answer": 4
  },
  {
    "type": "TEMPS",
    "q": "Temps pour faire le tour du monde en avion direct ?",
    "unit": "En heures",
    "answer": 45
  },
  {
    "type": "TEMPS",
    "q": "Durée d'un jour sur Mars (un sol) ?",
    "unit": "En heures",
    "answer": 24.6
  },
  {
    "type": "TEMPS",
    "q": "Temps d'incubation d'un oeuf de poule ?",
    "unit": "En jours",
    "answer": 21
  },
  {
    "type": "TEMPS",
    "q": "Durée d'une mi-temps au rugby ?",
    "unit": "En minutes",
    "answer": 40
  },
  {
    "type": "CULTURE",
    "q": "Année de sortie de Minecraft ?",
    "unit": "En année",
    "answer": 2011
  },
  {
    "type": "CULTURE",
    "q": "Année de la chute du mur de Berlin ?",
    "unit": "En année",
    "answer": 1989
  },
  {
    "type": "CULTURE",
    "q": "Année de création de Facebook ?",
    "unit": "En année",
    "answer": 2004
  },
  {
    "type": "CULTURE",
    "q": "Nombre de tomes Dragon Ball (manga original) ?",
    "unit": "En tomes",
    "answer": 42
  },
  {
    "type": "CULTURE",
    "q": "Nombre de films Harry Potter ?",
    "unit": "En films",
    "answer": 8
  },
  {
    "type": "CULTURE",
    "q": "Nombre de joueurs sur un terrain de rugby à XV ?",
    "unit": "En joueurs",
    "answer": 15
  },
  {
    "type": "CULTURE",
    "q": "Année du premier pas sur la Lune ?",
    "unit": "En année",
    "answer": 1969
  },
  {
    "type": "CULTURE",
    "q": "Nombre de couleurs dans un Rubik's Cube ?",
    "unit": "En couleurs",
    "answer": 6
  },
  {
    "type": "CULTURE",
    "q": "Nombre de lettres dans l'alphabet français ?",
    "unit": "En lettres",
    "answer": 26
  },
  {
    "type": "CULTURE",
    "q": "Nombre d'étoiles sur le drapeau européen ?",
    "unit": "En étoiles",
    "answer": 12
  },
  {
    "type": "CORPS",
    "q": "Nombre de litres d'air inspirés par jour ?",
    "unit": "En litres",
    "answer": 10000
  },
  {
    "type": "CORPS",
    "q": "Longueur totale des vaisseaux sanguins chez un adulte ?",
    "unit": "En km",
    "answer": 100000
  },
  {
    "type": "CORPS",
    "q": "Nombre de papilles gustatives sur la langue ?",
    "unit": "En papilles",
    "answer": 10000
  },
  {
    "type": "CORPS",
    "q": "Poids d'un foie humain adulte ?",
    "unit": "En kg",
    "answer": 1.5
  },
  {
    "type": "CORPS",
    "q": "Durée de vie d'un globule rouge ?",
    "unit": "En jours",
    "answer": 120
  },
  {
    "type": "CORPS",
    "q": "Nombre de battements du coeur par minute au repos ?",
    "unit": "En bpm",
    "answer": 70
  },
  {
    "type": "CORPS",
    "q": "Surface de la peau d'un adulte ?",
    "unit": "En m2",
    "answer": 2
  },
  {
    "type": "CORPS",
    "q": "Nombre d'os dans une main ?",
    "unit": "En os",
    "answer": 27
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse d'un faucon pèlerin en piqué ?",
    "unit": "En km/h",
    "answer": 390
  },
  {
    "type": "ANIMAL",
    "q": "Poids d'un colibri ?",
    "unit": "En g",
    "answer": 4
  },
  {
    "type": "ANIMAL",
    "q": "Nombre d'années que dort une marmotte par an ?",
    "unit": "En mois",
    "answer": 6
  },
  {
    "type": "ANIMAL",
    "q": "Distance parcourue par un manchot empereur sous l'eau ?",
    "unit": "En km",
    "answer": 1000
  },
  {
    "type": "ANIMAL",
    "q": "Nombre d'oeufs pondus par une poule par an ?",
    "unit": "En oeufs",
    "answer": 300
  },
  {
    "type": "ANIMAL",
    "q": "Vitesse d'un dauphin ?",
    "unit": "En km/h",
    "answer": 40
  },
  {
    "type": "ANIMAL",
    "q": "Poids maximal d'un requin blanc ?",
    "unit": "En kg",
    "answer": 2000
  },
  {
    "type": "ANIMAL",
    "q": "Durée de gestation d'un éléphant ?",
    "unit": "En mois",
    "answer": 22
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de dents d'un adulte avec dents de sagesse ?",
    "unit": "En dents",
    "answer": 32
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de pays dans l'Union Européenne ?",
    "unit": "En pays",
    "answer": 27
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de pays dans le monde reconnus par l'ONU ?",
    "unit": "En pays",
    "answer": 193
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de touches sur un clavier AZERTY standard ?",
    "unit": "En touches",
    "answer": 105
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de secondes dans une journée ?",
    "unit": "En secondes",
    "answer": 86400
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de joueurs dans une équipe de basket sur le terrain ?",
    "unit": "En joueurs",
    "answer": 5
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre d'heures dans une semaine ?",
    "unit": "En heures",
    "answer": 168
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de faces d'un dé standard ?",
    "unit": "En faces",
    "answer": 6
  },
  {
    "type": "QUANTITÉ",
    "q": "Nombre de cordes sur une guitare classique ?",
    "unit": "En cordes",
    "answer": 6
  }
];

const TYPE_WEIGHTS = {"PRIX":5,"POIDS":5,"DISTANCE":4,"LONGUEUR":4,"POPULATION":4,"QUANTITÉ":4,"TEMPS":3,"CULTURE":3,"CORPS":3,"ANIMAL":4};
const NORMAL_TYPES = ["PRIX","POIDS","DISTANCE","LONGUEUR","POPULATION","QUANTITÉ","TEMPS","CULTURE","CORPS","ANIMAL"];
const ALL_TYPES = [...NORMAL_TYPES];
const DEFAULT_CONFIG = { numRounds:10, baseTime:20, autoDelay:5, wtfRatio:0, allowedTypes:null };
const ROUND_GRACE_MS=400;const RECONNECT_GRACE_MS=30000;
const isPlayable=q=>!!q&&typeof q.q==='string'&&Number.isFinite(q.answer)&&q.answer!==0;
function shuffle(a){a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function sanitizeConfig(input,base){const out={...base};if(!input||typeof input!=='object')return out;const c=(v,min,max,f)=>{const n=Number(v);return Number.isFinite(n)?Math.min(max,Math.max(min,Math.round(n))):f;};if('numRounds'in input)out.numRounds=c(input.numRounds,1,30,base.numRounds);if('baseTime'in input)out.baseTime=c(input.baseTime,5,60,base.baseTime);if('autoDelay'in input)out.autoDelay=c(input.autoDelay,2,30,base.autoDelay);return out;}
function pickRandomQuestions(cfg){const n=cfg?.numRounds||10;let pool=QUESTIONS_BANK.filter(isPlayable);const picked=[];const used=new Set();const w=q=>TYPE_WEIGHTS[q.type]||1;let src=pool.filter(q=>!used.has(q.q));for(let k=0;k<n&&src.length>0;k++){const tot=src.reduce((s,q)=>s+w(q),0);let r=Math.random()*tot;let idx=src.length-1;for(let j=0;j<src.length;j++){r-=w(src[j]);if(r<=0){idx=j;break;}}const q=src[idx];picked.push(q);used.add(q.q);src=src.filter(x=>x.q!==q.q);}return shuffle(picked).slice(0,n);}
function parseGuess(v){if(typeof v==='number')return Number.isFinite(v)?v:null;if(typeof v!=='string')return null;const s=v.trim().replace(/[\s\u00a0\u202f]/g,'').replace(',','.');if(!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s))return null;const n=Number(s);return Number.isFinite(n)?n:null;}
function calcPoints(g,a){const gg=parseGuess(g);if(gg===null||!Number.isFinite(a))return 0;if(a===0)return gg===0?1000:50;const err=Math.abs(gg-a)/Math.abs(a);return Math.max(50,Math.round(1000*Math.max(0,1-err*1.5)));}
function getTimeForRound(i,b){b=Number(b)||20;return Math.max(6,b-i*2-Math.floor(i/3));}
const lobby={id:'main',name:'Lobby Principal',isCreated:false,createdBy:null,createdByName:null,players:{},roster:{},gameState:'waiting',phase:'idle',config:{...DEFAULT_CONFIG},questions:[],currentRound:0,answers:{},scores:{},roundEndsAt:0,roundDuration:0,earlyFinish:false};
const runtime={tick:null,timeouts:new Set(),gameId:0};
function clearRuntime(){clearInterval(runtime.tick);runtime.tick=null;runtime.timeouts.forEach(t=>clearTimeout(t));runtime.timeouts.clear();runtime.gameId++;}
function later(fn,ms){const id=runtime.gameId;const t=setTimeout(()=>{runtime.timeouts.delete(t);if(id===runtime.gameId)fn();},ms);runtime.timeouts.add(t);return t;}
function getPlayersArray(){return Object.values(lobby.players).map(p=>({id:p.id,username:p.username,avatar:p.avatar,ready:p.ready,connected:p.connected,isAnimator:p.isAnimator,score:lobby.scores[p.id]||0}));}
function getLobbyPublic(){return{id:lobby.id,name:lobby.name,isCreated:lobby.isCreated,createdBy:lobby.createdBy,createdByName:lobby.createdByName,gameState:lobby.gameState,config:lobby.config,currentRound:lobby.currentRound,players:getPlayersArray(),totalPlayers:Object.keys(lobby.players).length};}
const broadcastLobby=()=>io.to('main').emit('lobby:update',getLobbyPublic());
const broadcastConfig=()=>io.to('main').emit('config:update',lobby.config);
const connectedPlayers=()=>Object.values(lobby.players).filter(p=>p.connected);
function buildLeaderboard(){return Object.entries(lobby.scores).map(([id,score])=>({id,username:lobby.roster[id]?.username||'joueur',avatar:lobby.roster[id]?.avatar||null,score})).sort((a,b)=>b.score-a.score);}
const publicQuestion=q=>({type:q.type,q:q.q,unit:q.unit});
function roundPayload(i,uid){const rem=Math.max(0,(lobby.roundEndsAt-Date.now())/1000);return{round:i,totalRounds:lobby.questions.length,question:publicQuestion(lobby.questions[i]),time:Math.round(rem*10)/10,totalTime:lobby.roundDuration,answered:uid?(lobby.answers[i]||{})[uid]!==undefined:false};}
function beginRound(i){if(lobby.gameState!=='playing')return;if(i>=lobby.questions.length){endGame();return;}lobby.currentRound=i;lobby.phase='question';lobby.earlyFinish=false;lobby.answers[i]={};lobby.roundDuration=getTimeForRound(i,lobby.config.baseTime);lobby.roundEndsAt=Date.now()+lobby.roundDuration*1000;io.to('players').emit('round:started',roundPayload(i));clearInterval(runtime.tick);runtime.tick=setInterval(()=>{const rem=Math.max(0,(lobby.roundEndsAt-Date.now())/1000);io.to('players').emit('timer:update',{round:i,timeLeft:Math.ceil(rem*10)/10});if(rem<=0){clearInterval(runtime.tick);runtime.tick=null;later(()=>finishRound(i),ROUND_GRACE_MS);}},100);}
function finishRound(i){if(lobby.gameState!=='playing'||lobby.phase!=='question'||lobby.currentRound!==i)return;lobby.phase='results';clearInterval(runtime.tick);runtime.tick=null;const q=lobby.questions[i];const ra=lobby.answers[i]||{};const res=[];for(const p of Object.values(lobby.players)){const g=ra[p.id];const pts=calcPoints(g,q.answer);lobby.scores[p.id]=(lobby.scores[p.id]||0)+pts;res.push({id:p.id,username:p.username,guess:g===undefined?null:g,points:pts,total:lobby.scores[p.id]});}res.sort((a,b)=>b.points-a.points||b.total-a.total);io.to('players').emit('round:finished',{round:i,totalRounds:lobby.questions.length,isLast:i+1>=lobby.questions.length,nextIn:lobby.config.autoDelay,question:{type:q.type,q:q.q,unit:q.unit,answer:q.answer},correctAnswer:q.answer,results:res,leaderboard:buildLeaderboard()});later(()=>beginRound(i+1),lobby.config.autoDelay*1000);}
function endGame(){const lb=buildLeaderboard();clearRuntime();lobby.gameState='waiting';lobby.phase='idle';Object.values(lobby.players).forEach(p=>{p.ready=false;});io.to('players').emit('game:finished',{leaderboard:lb});broadcastLobby();}
function abortGame(){clearRuntime();lobby.gameState='waiting';lobby.phase='idle';lobby.currentRound=0;lobby.answers={};lobby.scores={};Object.keys(lobby.players).forEach(id=>{lobby.scores[id]=0;});Object.values(lobby.players).forEach(p=>{p.ready=false;});}
function maybeFinishEarly(){if(lobby.gameState!=='playing'||lobby.phase!=='question'||lobby.earlyFinish)return;const act=connectedPlayers();if(act.length===0)return;const ans=lobby.answers[lobby.currentRound]||{};if(!act.every(p=>ans[p.id]!==undefined))return;lobby.earlyFinish=true;clearInterval(runtime.tick);runtime.tick=null;const r=lobby.currentRound;later(()=>finishRound(r),700);}
function createParty(u){if(lobby.isCreated)return;lobby.isCreated=true;lobby.createdBy=u.id;lobby.createdByName=u.username;lobby.gameState='waiting';lobby.phase='idle';}
function dissolveParty(){lobby.isCreated=false;lobby.createdBy=null;lobby.createdByName=null;}
function addPlayer(u,s){const ex=lobby.players[u.id];if(ex&&ex.graceTimer)clearTimeout(ex.graceTimer);lobby.players[u.id]={id:u.id,username:u.username,avatar:u.avatar,ready:ex?ex.ready:false,connected:true,socketId:s.id,isAnimator:isAnimatorUser(u),graceTimer:null};lobby.roster[u.id]={username:u.username,avatar:u.avatar};if(lobby.scores[u.id]===undefined)lobby.scores[u.id]=0;s.join('players');broadcastLobby();if(lobby.gameState==='playing'&&lobby.phase==='question'){s.emit('round:started',{...roundPayload(lobby.currentRound,u.id),sync:true});}}
function removePlayer(id){const p=lobby.players[id];if(!p)return;if(p.graceTimer)clearTimeout(p.graceTimer);if(p.isAnimator){resetLobby();return;}delete lobby.players[id];io.sockets.sockets.forEach(s=>{if(s.user&&s.user.id===id)s.leave('players');});if(Object.keys(lobby.players).length===0){if(lobby.gameState==='playing')abortGame();dissolveParty();}broadcastLobby();maybeFinishEarly();}
function otherLiveSocket(uid,ex){let f=null;io.sockets.sockets.forEach(s=>{if(!f&&s.id!==ex&&s.user&&s.user.id===uid)f=s;});return f;}
function resetLobby(){clearRuntime();Object.values(lobby.players).forEach(p=>{if(p.graceTimer)clearTimeout(p.graceTimer);});lobby.players={};lobby.roster={};lobby.gameState='waiting';lobby.phase='idle';lobby.questions=[];lobby.currentRound=0;lobby.answers={};lobby.scores={};dissolveParty();io.in('players').socketsLeave('players');io.to('main').emit('lobby:closed');broadcastLobby();}
const cookieOpts=(req,extra={})=>({sameSite:'lax',secure:!!req.secure,path:'/',...extra});
app.get('/auth/discord',(req,res)=>{if(!CLIENT_ID)return res.status(500).send('DISCORD_CLIENT_ID manquant');const st=crypto.randomBytes(16).toString('hex');res.cookie('ap_oauth_state',st,cookieOpts(req,{httpOnly:true,maxAge:10*60*1000}));const ps=new URLSearchParams({client_id:CLIENT_ID,redirect_uri:REDIRECT_URI,response_type:'code',scope:'identify',state:st});res.redirect(`https://discord.com/api/oauth2/authorize?${ps.toString()}`);});
app.get('/auth/callback',async(req,res)=>{const {code,state,error}=req.query;if(error||!code)return res.redirect('/');const exp=req.cookies.ap_oauth_state;res.clearCookie('ap_oauth_state',{path:'/'});if(!exp||state!==exp)return res.status(400).send('Connexion expirée');try{const tr=await axios.post('https://discord.com/api/oauth2/token',new URLSearchParams({client_id:CLIENT_ID,client_secret:CLIENT_SECRET,grant_type:'authorization_code',code:String(code),redirect_uri:REDIRECT_URI,}),{headers:{'Content-Type':'application/x-www-form-urlencoded'}});const at=tr.data.access_token;const ur=await axios.get('https://discord.com/api/users/@me',{headers:{Authorization:`Bearer ${at}`}});const user={id:String(ur.data.id),username:ur.data.username,avatar:ur.data.avatar?`https://cdn.discordapp.com/avatars/${ur.data.id}/${ur.data.avatar}.png`:null,discriminator:ur.data.discriminator};res.cookie('ap_session',signSession(user),cookieOpts(req,{httpOnly:true,maxAge:SESSION_MAX_AGE_MS}));res.cookie('ap_user',JSON.stringify(user),cookieOpts(req,{httpOnly:false,maxAge:SESSION_MAX_AGE_MS}));res.redirect(`/?discord_user=${encodeURIComponent(JSON.stringify(user))}#logged`);}catch(e){console.error(e.response?.data||e.message);res.status(500).send('Erreur Discord');}});
app.post('/logout',(req,res)=>{const u=sessionFromReq(req);res.clearCookie('ap_user',{path:'/'});res.clearCookie('ap_session',{path:'/'});if(u&&lobby.players[u.id])removePlayer(u.id);res.json({ok:true});});
function sessionFromReq(req){return verifySession(req.cookies&&req.cookies.ap_session);}
app.get('/api/me',(req,res)=>{const u=sessionFromReq(req);if(!u)return res.status(401).json({error:'not logged'});res.json({...u,isAnimator:isAnimatorUser(u)});});
app.get(['/api/lobby','/api/lobby/:id'],(req,res)=>{res.json(getLobbyPublic());});
app.get('/api/config',(req,res)=>{res.json({animatorId:ANIMATOR_ID,discordInviteUrl:DISCORD_INVITE_URL,port:PORT});});
app.post('/api/reset',(req,res)=>{if(!isAnimatorUser(sessionFromReq(req)))return res.status(403).json({error:'Réservé'});resetLobby();res.json({ok:true,lobby:getLobbyPublic()});});
io.use((socket,next)=>{socket.user=verifySession(parseCookieHeader(socket.handshake.headers.cookie).ap_session);next();});
io.on('connection',socket=>{
const needAnim=()=>{if(!isAnimatorUser(socket.user)){socket.emit('error','Réservé');return false;}return true;};
socket.on('auth',()=>{const u=socket.user;if(!u){socket.emit('auth:error','Session expirée');return;}socket.join('main');const inL=!!lobby.players[u.id];socket.emit('auth:ok',{user:u,isAnimator:isAnimatorUser(u),animatorId:ANIMATOR_ID,inLobby:inL,gameState:lobby.gameState});socket.emit('config:update',lobby.config);if(inL)addPlayer(u,socket);else socket.emit('lobby:update',getLobbyPublic());});
socket.on('lobby:join',()=>{const u=socket.user;if(!u){socket.emit('auth:error','Session expirée');return;}if(!lobby.isCreated){if(isAnimatorUser(u))createParty(u);else{socket.emit('lobby:closed');return;}}socket.join('main');addPlayer(u,socket);});
socket.on('lobby:leave',()=>{if(socket.user)removePlayer(socket.user.id);});
socket.on('player:ready',()=>{const p=socket.user&&lobby.players[socket.user.id];if(!p||lobby.gameState==='playing')return;p.ready=!p.ready;broadcastLobby();});
socket.on('animator:create',()=>{if(!needAnim())return;const was=lobby.isCreated;createParty(socket.user);broadcastLobby();if(!was)io.to('main').emit('party:created',{createdBy:socket.user.username,config:lobby.config});});
socket.on('animator:cancel',()=>{if(!needAnim())return;if(lobby.isCreated&&lobby.gameState!=='playing'&&Object.keys(lobby.players).length===0){dissolveParty();broadcastLobby();}});
socket.on('animator:config:update',nc=>{if(!needAnim())return;if(lobby.gameState==='playing'){socket.emit('error','Impossible pendant partie');return;}createParty(socket.user);lobby.config=sanitizeConfig(nc,lobby.config);broadcastConfig();broadcastLobby();});
socket.on('game:launch',()=>{if(!needAnim())return;if(lobby.gameState==='playing'){socket.emit('error','Partie en cours');return;}if(Object.keys(lobby.players).length===0){socket.emit('error','Aucun joueur');return;}createParty(socket.user);const qs=pickRandomQuestions(lobby.config);if(qs.length===0){socket.emit('error','Aucune question');return;}clearRuntime();lobby.questions=qs;lobby.currentRound=0;lobby.answers={};lobby.scores={};Object.keys(lobby.players).forEach(id=>{lobby.scores[id]=0;});lobby.gameState='playing';lobby.phase='starting';io.to('players').emit('game:started',{config:lobby.config,totalRounds:qs.length});broadcastLobby();later(()=>beginRound(0),1000);});
socket.on('game:answer',pl=>{const u=socket.user;if(!u||!lobby.players[u.id])return;const {round,answer}=pl||{};if(lobby.gameState!=='playing'||lobby.phase!=='question')return;if(Number(round)!==lobby.currentRound)return;if(Date.now()>lobby.roundEndsAt+ROUND_GRACE_MS)return;const ra=lobby.answers[lobby.currentRound]||(lobby.answers[lobby.currentRound]={});if(ra[u.id]!==undefined)return;const num=parseGuess(answer);if(num===null){socket.emit('answer:rejected',{round:lobby.currentRound,reason:'Invalide'});return;}ra[u.id]=num;const act=connectedPlayers();io.to('players').emit('player:answered',{round:lobby.currentRound,answeredCount:act.filter(p=>ra[p.id]!==undefined).length,totalPlayers:act.length,playerId:u.id});maybeFinishEarly();});
socket.on('game:reset',()=>{if(!needAnim())return;abortGame();io.to('players').emit('game:reset');broadcastLobby();});
socket.on('disconnect',()=>{const u=socket.user;if(!u)return;const p=lobby.players[u.id];if(!p)return;const ot=otherLiveSocket(u.id,socket.id);if(ot){p.socketId=ot.id;return;}if(p.socketId!==socket.id)return;if(lobby.gameState==='playing'){p.connected=false;broadcastLobby();maybeFinishEarly();p.graceTimer=setTimeout(()=>{const cur=lobby.players[u.id];if(cur&&!cur.connected)removePlayer(u.id);},RECONNECT_GRACE_MS);}else{removePlayer(u.id);}});
});
server.listen(PORT,()=>{console.log(`✅ Serveur prêt sur http://localhost:${PORT}`);});

