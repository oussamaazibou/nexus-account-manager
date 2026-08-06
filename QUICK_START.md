# Quick Start - Copy & Paste These Commands

## 1. Navigate to Project Directory
cd "c:\Users\PC\Desktop\G-Tools\abd-createWorkspaceAccount\createWorkspaceAccount\createWorkspaceAccount"

## 2. Verify Node.js Installation
node --version

## 3. Install Dependencies (if needed)
npm install

## 4. Add Your Domains to domains.txt
# Edit the file and add domains (one per line):
# example1.edu.us
# example2.edu.us

## 5. Run the Script
node createWorkspaceScript.js

## Optional: Reinstall Dependencies (if errors occur)
# Remove node_modules
rm -r node_modules
rm package-lock.json
npm install
