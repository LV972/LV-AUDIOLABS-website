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

// Configuration Stripe : URL du Worker Cloudflare une fois déployé
// (voir stripe-worker/README.md, section « Déploiement du Worker »).
// Tant que cette valeur est VIDE, l'abonnement Pro n'est PAS configuré : les
// boutons de paiement / portail / rétractation affichent un message explicite
// au lieu d'échouer sur une URL factice. Pour activer l'abonnement, déployez
// le Worker puis renseignez son URL publique ci-dessous.
const STRIPE_WORKER_URL = "";

const $ = (id) => document.getElementById(id);

let auth = null;
let db = null;
let limiteFree = LIMITE_DEFAUT;
let utilisateurCourant = null;
let profilCourant = null;

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
  retirerBadgePro();
  retirerBoutonGestionAbonnement();
  actualiserSectionRetractation();
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

  // Afficher le badge Pro et le bouton de gestion d'abonnement si applicable
  if (pro) {
    ajouterBadgePro();
    ajouterBoutonGestionAbonnement();
  } else {
    retirerBadgePro();
    retirerBoutonGestionAbonnement();
  }

  actualiserSectionRetractation();
}

function ajouterBadgePro() {
  let badge = document.getElementById("badge-pro");
  if (!badge) {
    badge = document.createElement("span");
    badge.id = "badge-pro";
    badge.textContent = " ⭐ Pro";
    badge.style.cssText = "margin-left: 8px; color: #ffd700; font-weight: 600;";
    $("compte-plan").appendChild(badge);
  }
}

function retirerBadgePro() {
  const badge = document.getElementById("badge-pro");
  if (badge) badge.remove();
}

function ajouterBoutonGestionAbonnement() {
  const actions = document.querySelector(".account-actions");
  if (!actions) return;
  
  if (!document.getElementById("btn-gerer-abonnement")) {
    const btn = document.createElement("button");
    btn.id = "btn-gerer-abonnement";
    btn.type = "button";
    btn.className = "btn btn-ghost";
    btn.textContent = "Gérer / Résilier mon abonnement";
    btn.style.marginLeft = "8px";
    btn.addEventListener("click", ouvrirPortailStripe);
    actions.appendChild(btn);
  }
}

function retirerBoutonGestionAbonnement() {
  const btn = document.getElementById("btn-gerer-abonnement");
  if (btn) btn.remove();
}

// ---------- Stripe : Checkout & Portail Client ----------

async function ouvrirCheckoutStripe() {
  if (!STRIPE_WORKER_URL) {
    alert("L'abonnement Pro n'est pas encore disponible : le service de paiement n'est pas configuré.");
    return;
  }

  if (!utilisateurCourant) {
    alert("Veuillez vous connecter avec Google avant de souscrire à l'abonnement Pro.");
    return;
  }

  if (profilCourant?.plan === "pro") {
    alert("Vous avez déjà un abonnement Pro actif.");
    return;
  }

  if (!await confirmerRenonciationRetractation()) {
    return;
  }

  try {
    const reponse = await fetch(`${STRIPE_WORKER_URL}/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: utilisateurCourant.uid,
        email: utilisateurCourant.email,
      }),
    });

    if (!reponse.ok) {
      const erreur = await reponse.json().catch(() => ({}));
      throw new Error(erreur.message || "Erreur lors de la création de la session de paiement.");
    }

    const { url } = await reponse.json();
    if (url) {
      window.location.href = url;
    }
  } catch (erreur) {
    console.error("Erreur Stripe Checkout:", erreur);
    alert(`Impossible d'ouvrir le paiement : ${erreur.message}`);
  }
}

// ---------- Rétractation : confirmation légale et enregistrement ----------

function confirmerRenonciationRetractation() {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex;
      align-items: center; justify-content: center; z-index: 10000;
      font-family: 'Work Sans', sans-serif;
    `;
    modal.innerHTML = `
      <div style="background: var(--bg-raised, #151313); border: 1px solid var(--line, #2a2626); border-radius: 8px; padding: 32px; max-width: 500px; width: 90%; color: var(--cream, #f2ede7);">
        <h3 style="margin-top: 0; color: var(--red, #d61f3c);">Souscription à LV AUDIO LABS Pro — 4,99 €/mois</h3>
        <p style="color: var(--grey, #b8b0a8); margin-bottom: 20px;">
          En validant, vous souscrivez à un abonnement mensuel de <strong>4,99 € TTC</strong> (reconduction tacite, résiliable à tout moment sans frais depuis votre espace compte).
        </p>
        <div style="background: var(--bg, #0b0a0a); border: 1px solid var(--line, #2a2626); border-radius: 4px; padding: 16px; margin-bottom: 20px;">
          <p style="margin: 0 0 12px 0; font-weight: 600; color: var(--red, #d61f3c);">⚠️ Droit de rétractation (Art. L. 221-28 13° du Code de la consommation)</p>
          <p style="margin: 0; font-size: 0.9em; color: var(--grey, #b8b0a8);">
            Ce service numérique vous est fourni <strong>immédiatement</strong> après paiement (accès illimité aux séparations).
            En cochant la case ci-dessous, vous demandez expressément cette exécution immédiate
            et <strong>renoncez à votre droit de rétractation de 14 jours</strong> dès l'activation de votre compte Pro.
          </p>
        </div>
        <label style="display: flex; align-items: flex-start; gap: 10px; cursor: pointer; margin-bottom: 24px;">
          <input type="checkbox" id="checkbox-retractation" style="margin-top: 2px; accent-color: var(--red, #d61f3c);">
          <span style="color: var(--cream, #f2ede7); font-size: 0.95em;">
            Je demande l'accès immédiat au service Pro et je renonce expressément à mon droit de rétractation de 14 jours.
          </span>
        </label>
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button id="btn-annuler-retractation" class="btn btn-ghost" style="padding: 10px 20px;">Annuler</button>
          <button id="btn-confirmer-retractation" class="btn" disabled style="padding: 10px 20px; background: var(--red, #d61f3c); border-color: var(--red, #d61f3c);">Confirmer et payer 4,99 €</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const checkbox = modal.querySelector("#checkbox-retractation");
    const btnConfirmer = modal.querySelector("#btn-confirmer-retractation");
    const btnAnnuler = modal.querySelector("#btn-annuler-retractation");

    checkbox.addEventListener("change", () => {
      btnConfirmer.disabled = !checkbox.checked;
    });

    btnAnnuler.addEventListener("click", () => {
      document.body.removeChild(modal);
      resolve(false);
    });

    btnConfirmer.addEventListener("click", () => {
      enregistrerRenonciationRetractation(utilisateurCourant.uid);
      document.body.removeChild(modal);
      resolve(true);
    });
  });
}

async function enregistrerRenonciationRetractation(uid) {
  try {
    const reference = doc(db, "users", uid);
    await setDoc(reference, {
      retractation_renoncee: true,
      retractation_timestamp: estampille(),
      updated_at: estampille(),
    }, { merge: true });
  } catch (e) {
    console.warn("Impossible d'enregistrer la renonciation à la rétractation:", e);
  }
}

// ---------- Rétractation en ligne (Décret n° 2026-3, art. D. 221-5) ----------

/**
 * Rend la fonctionnalité « Renoncer au contrat ici » directement accessible :
 * la section n'est révélée que si l'utilisateur est connecté, pendant les
 * 14 jours qui suivent la souscription.
 */
function actualiserSectionRetractation() {
  const section = $("retractation-form");
  if (!section) return;

  const champCourriel = $("retractation-email");
  const champUid = $("retractation-uid");

  if (!utilisateurCourant) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  champUid.value = utilisateurCourant.uid;
  if (!champCourriel.value) {
    champCourriel.value = utilisateurCourant.email || "";
  }
}

/** Soumet la déclaration de rétractation au Worker, qui horodate et accuse réception. */
async function envoyerRetractation(evenement) {
  evenement.preventDefault();

  const message = $("retractation-message");
  const bouton = document.querySelector("#form-retractation button[type=submit]");

  if (!STRIPE_WORKER_URL) {
    message.textContent = "Le service de rétractation en ligne n'est pas configuré. Contacte-nous par courriel.";
    return;
  }

  if (!utilisateurCourant) {
    message.textContent = "Connecte-toi avec Google pour exercer ta rétractation en ligne.";
    return;
  }

  bouton.disabled = true;
  message.textContent = "Envoi de la déclaration en cours…";

  try {
    const reponse = await fetch(`${STRIPE_WORKER_URL}/retractation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: utilisateurCourant.uid,
        email: $("retractation-email").value,
        moyen: $("retractation-moyen").value,
        confirmation: true, // équivaut au bouton « confirmer la rétractation »
      }),
    });

    const donnees = await reponse.json().catch(() => ({}));

    if (!reponse.ok) {
      throw new Error(donnees.message || "La déclaration n'a pas pu être enregistrée.");
    }

    message.textContent =
      `Rétractation enregistrée le ${donnees.horodatage} (heure UTC). ` +
      `${donnees.accuse_reception || ""}`;
    message.style.color = "var(--cream)";
  } catch (erreur) {
    message.textContent = `Erreur : ${erreur.message}`;
  } finally {
    bouton.disabled = false;
  }
}

// ---------- Portail Client Stripe (Gestion / Résiliation) ----------
async function ouvrirPortailStripe() {
  if (!STRIPE_WORKER_URL) {
    alert("Le portail client n'est pas configuré : aucun abonnement n'est encore actif.");
    return;
  }

  if (!utilisateurCourant) {
    alert("Veuillez vous connecter pour gérer votre abonnement.");
    return;
  }

  try {
    const reponse = await fetch(`${STRIPE_WORKER_URL}/create-portal-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: utilisateurCourant.uid,
      }),
    });

    if (!reponse.ok) {
      const erreur = await reponse.json().catch(() => ({}));
      throw new Error(erreur.message || "Erreur lors de l'ouverture du portail client.");
    }

    const { url } = await reponse.json();
    if (url) {
      window.location.href = url;
    }
  } catch (erreur) {
    console.error("Erreur Portail Stripe:", erreur);
    alert(`Impossible d'ouvrir le portail client : ${erreur.message}`);
  }
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
  
  // Bouton "Passer en Pro" sur la section Tarifs
  const btnPasserPro = $("btn-passer-pro");
  if (btnPasserPro) {
    btnPasserPro.addEventListener("click", ouvrirCheckoutStripe);
  }

  // Formulaire de rétractation en ligne (Décret n° 2026-3)
  const formulaire = $("form-retractation");
  if (formulaire) {
    formulaire.addEventListener("submit", envoyerRetractation);
  }

  onAuthStateChanged(auth, async (utilisateur) => {
    if (!utilisateur) {
      utilisateurCourant = null;
      profilCourant = null;
      afficherDeconnecte();
      return;
    }

    try {
      const profil = await chargerProfil(utilisateur);
      utilisateurCourant = utilisateur;
      profilCourant = profil;
      afficherConnecte(profil);
    } catch (erreur) {
      afficherDeconnecte(`Impossible de lire ton profil : ${messageErreur(erreur)}`);
    }
  });
}

demarrer();
