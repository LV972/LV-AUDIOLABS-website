// LV AUDIO LABS — Compte en ligne (Firebase Auth + Firestore, plan Spark)
//
// Ce module lit et ecrit EXACTEMENT le meme document users/{uid} que
// l'application de bureau (lv_cloud.py) : meme nom de champs, meme fenetre
// glissante de 24 h, memes valeurs de plan ("free" / "pro"). Le compte, son
// statut et les separations restantes sont donc identiques sur le site et
// dans le logiciel.
//
// Configuration : fetch de ./firebase_config.json (le meme fichier que
// l'application). Sans lui, la section affiche "non configuree" et le reste
// du site fonctionne normalement.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const FENETRE_MS = 24 * 60 * 60 * 1000; // fenêtre glissante de 24 h (comme l'app)
const LIMITE_DEFAUT = 5;

const $ = (id) => document.getElementById(id);

let auth = null;
let db = null;
let limiteFree = LIMITE_DEFAUT;

// ---------- petites aides ----------

function versEpoch(valeur) {
  if (!valeur) return 0;
  // l'application de bureau stocke des chaines ISO "YYYY-MM-DDTHH:MM:SSZ"
  if (typeof valeur === "object" && typeof valeur.toMillis === "function") {
    return valeur.toMillis();
  }
  const temps = Date.parse(valeur);
  return Number.isNaN(temps) ? 0 : temps;
}

function estampille(date = new Date()) {
  // même format que lv_cloud._estampille() : ISO UTC sans millisecondes.
  return date.toISOString().split(".")[0] + "Z";
}

function fenetreCourante(profil) {
  // miroir de lv_cloud._compteur_a_jour()
  const maintenant = Date.now();
  let reset = versEpoch(profil.last_reset_timestamp);
  let utilise = Number(profil.separations_used_24h) || 0;

  if (!reset || maintenant - reset >= FENETRE_MS) {
    utilise = 0;
    reset = maintenant;
  }
  return { utilise, reset };
}

function messageErreur(erreur) {
  const code = (erreur && erreur.code) || "";
  if (code === "auth/popup-closed-by-user") return "Fenêtre Google fermée avant la fin de la connexion.";
  if (code === "auth/popup-blocked") return "Le navigateur a bloqué la fenêtre Google : autorise les pop-ups pour ce site.";
  if (code === "auth/unauthorized-domain") {
    return "Ce domaine n'est pas autorisé : ajoute-le dans Firebase > Authentication > Settings > Authorized domains.";
  }
  return (erreur && erreur.message) || "Connexion impossible pour le moment.";
}

// ---------- interface ----------

function afficherDeconnecte(texte) {
  $("compte-statut").textContent = texte || "Non connecté";
  $("compte-plan").textContent = "—";
  $("compte-quota").textContent = "—";
  $("compte-email").textContent = "";
  $("btn-connexion-google").hidden = false;
  $("btn-deconnexion").hidden = true;
}

function afficherConnecte(profil) {
  const { utilise } = fenetreCourante(profil);
  const plan = profil.plan === "pro" ? "Pro" : "Gratuit";
  const pro = profil.plan === "pro";

  $("compte-statut").textContent = "Connecté";
  $("compte-email").textContent = profil.email || "";
  $("compte-plan").textContent = plan;
  $("compte-quota").textContent = pro
    ? "Séparations illimitées"
    : `${Math.max(0, limiteFree - utilise)} / ${limiteFree} séparations restantes (24 h)`;
  $("btn-connexion-google").hidden = true;
  $("btn-deconnexion").hidden = false;
}

// ---------- profil Firestore (même schéma que lv_cloud.py) ----------

async function chargerProfil(utilisateur) {
  const reference = doc(db, "users", utilisateur.uid);
  const snapshot = await getDoc(reference);

  if (snapshot.exists()) {
    const profil = snapshot.data();
    // compléte éventuellement un document créé par une version plus ancienne
    if (!profil.email && utilisateur.email) {
      await setDoc(reference, { email: utilisateur.email, updated_at: estampille() }, { merge: true });
      profil.email = utilisateur.email;
    }
    return profil;
  }

  const profil = {
    email: utilisateur.email || "",
    plan: "free",
    separations_used_24h: 0,
    last_reset_timestamp: estampille(),
    created_at: estampille(),
    updated_at: estampille(),
  };
  await setDoc(reference, profil);
  return profil;
}

// ---------- actions ----------

async function connexionGoogle() {
  $("btn-connexion-google").disabled = true;
  $("compte-statut").textContent = "Connexion Google en cours…";

  try {
    const fournisseur = new GoogleAuthProvider();
    await signInWithPopup(auth, fournisseur);
    // onAuthStateChanged prend le relais et affiche le profil.
  } catch (erreur) {
    afficherDeconnecte(messageErreur(erreur));
  } finally {
    $("btn-connexion-google").disabled = false;
  }
}

async function deconnexion() {
  await signOut(auth);
  afficherDeconnecte("Non connecté — reconnecte-toi pour retrouver ton plan et tes quotas.");
}

// ---------- démarrage ----------

async function chargerConfiguration() {
  try {
    const reponse = await fetch("firebase_config.json", { cache: "no-store" });
    if (!reponse.ok) return null;
    const configuration = await reponse.json();
    return configuration && configuration.apiKey && configuration.projectId ? configuration : null;
  } catch {
    return null; // fichier absent : le site reste utilisable sans compte en ligne
  }
}

async function demarrer() {
  const statut = $("compte-statut");

  if (!statut) return; // page sans section de compte

  const configuration = await chargerConfiguration();

  if (!configuration) {
    afficherDeconnecte("Compte en ligne non configuré sur ce site (firebase_config.json absent).");
    $("btn-connexion-google").disabled = true;
    return;
  }

  limiteFree = Number(configuration.limite_free_24h) || LIMITE_DEFAUT;

  const app = initializeApp(configuration);
  auth = getAuth(app);
  db = getFirestore(app);

  $("btn-connexion-google").addEventListener("click", connexionGoogle);
  $("btn-deconnexion").addEventListener("click", deconnexion);

  onAuthStateChanged(auth, async (utilisateur) => {
    if (!utilisateur) {
      afficherDeconnecte();
      return;
    }

    try {
      const profil = await chargerProfil(utilisateur);
      afficherConnecte(profil);
    } catch (erreur) {
      afficherDeconnecte(`Impossible de lire ton profil : ${messageErreur(erreur)}`);
    }
  });
}

demarrer();
