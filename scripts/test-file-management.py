#!/usr/bin/env python3
"""Run file-management integration tests in an isolated local PostgreSQL cluster."""
import os,pathlib,subprocess,tempfile,socket,shutil
os.chdir(pathlib.Path(__file__).resolve().parents[1])
root=pathlib.Path(tempfile.mkdtemp(prefix='chordv-files-test-'));started=False
try:
 subprocess.run(['initdb','-D',str(root/'pg'),'-A','trust','-U','chordv_test'],check=True,stdout=subprocess.DEVNULL)
 sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
 subprocess.run(['pg_ctl','-D',str(root/'pg'),'-l',str(root/'pg.log'),'-o',f'-h 127.0.0.1 -p {port} -k {root}','-w','start'],check=True,stdout=subprocess.DEVNULL);started=True
 env=os.environ.copy();env.update(DATABASE_URL=f'postgresql://chordv_test@127.0.0.1:{port}/postgres',CHORDV_RELEASE_STORAGE_ROOT=str(root/'storage'),CHORDV_FILE_TEST_ISOLATED='1')
 subprocess.run(['node','apps/api/node_modules/prisma/build/index.js','migrate','deploy','--schema','apps/api/prisma/schema.prisma'],env=env,check=True,stdout=subprocess.DEVNULL)
 subprocess.run(['node','node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs','--tsconfig','apps/api/tsconfig.json','apps/api/test/file-management.integration.ts'],env=env,check=True)
finally:
 if started:subprocess.run(['pg_ctl','-D',str(root/'pg'),'-m','fast','-w','stop'],stdout=subprocess.DEVNULL,check=True)
 shutil.rmtree(root)
