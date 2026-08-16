# 🤖 Bot Discord Officiel — Richman Estate RP

Bot Discord v14 automatisé pour le serveur RP **Richman Estate**.

## 🚀 Fonctionnalités
- **Validation du Règlement :** Bouton `✅ J'accepte le règlement` dans `# 📋 ・ Reglement` débloquant le rôle *Membre*.
- **Formulaire d'Enregistrement :** Pop-up Discord Modal dans `# 📝 ・ Enregistrement` (Demande *Prénom*, *Nom*, *ID RP*).
- **Renommage Automatique :** Renomme automatiquement le membre sous le format `Prénom Nom | ID` (ex: `Marc Louis | 62336`).
- **Attribution des Rôles :** Donne le rôle `Citoyen` pour débloquer l'accès complet au serveur Discord.

---

## 🛠️ Lancement Rapide

1. **Installer les dépendances :**
   ```bash
   npm install
   ```

2. **Configurer le fichier `.env` :**
   Ouvrez le fichier `.env` et ajoutez votre Token Bot Discord ainsi que les IDs de rôles :
   ```env
   DISCORD_TOKEN=votre_token_discord_ici
   ROLE_MEMBRE_ID=votre_id_role_membre
   ROLE_CITOYEN_ID=votre_id_role_citoyen
   ```

3. **Démarrer le Bot en local :**
   ```bash
   npm start
   ```

---

## 🌐 Déploiement sur Render (Web Service + Uptime 24/7)

1. **Créer un Web Service sur [Render.com](https://render.com) :**
   - **Root Directory :** `richman-discord-bot`
   - **Environment :** `Node`
   - **Build Command :** `npm install`
   - **Start Command :** `npm start`
2. **Ajouter les Variables d'Environnement sur Render :**
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `ROLE_MEMBRE_ID`
   - `ROLE_CITOYEN_ID`
   - `ROLE_OWNER_ID`
   - `ROLE_ADMIN_ID`
   - `MASTER_OWNER_ID`
3. **Configurer l'Uptime (Keepalive 24/7) :**
   - Sur [cron-job.org](https://cron-job.org) ou [UptimeRobot](https://uptimerobot.com) :
   - Créer un moniteur HTTP **GET** toutes les 5 minutes vers : `https://votre-bot.onrender.com/health`
