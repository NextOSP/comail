#!/usr/bin/env python3
"""Minimal SMTP sink with STARTTLS + AUTH PLAIN for testing Comail's send path.
Writes each received message to OUTDIR/<n>.eml. Port 10588."""
import asyncio, ssl, base64, sys, os

OUTDIR = sys.argv[1]
CERT = sys.argv[2]
KEY = sys.argv[3]
PORT = 10588
counter = 0

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(CERT, KEY)


async def handle(reader, writer):
    global counter

    async def send(line):
        writer.write((line + "\r\n").encode())
        await writer.drain()

    async def recv():
        line = await reader.readline()
        return line.decode(errors="replace").rstrip("\r\n")

    await send("220 sink.local ESMTP test sink")
    tls = False
    authed = False
    mail_from = None
    rcpts = []
    while True:
        line = await recv()
        if not line:
            break
        verb = line.split(" ")[0].upper()
        if verb in ("EHLO", "HELO"):
            await send("250-sink.local")
            if not tls:
                await send("250-STARTTLS")
            await send("250-AUTH PLAIN LOGIN")
            await send("250 8BITMIME")
        elif verb == "STARTTLS":
            await send("220 Ready to start TLS")
            transport = writer.transport
            loop = asyncio.get_event_loop()
            new_transport = await loop.start_tls(transport, writer.transport.get_protocol(), ctx, server_side=True)
            reader._transport = new_transport
            writer._transport = new_transport
            tls = True
        elif verb == "AUTH":
            # AUTH PLAIN <b64> (initial response form)
            parts = line.split(" ")
            if len(parts) >= 3 and parts[1].upper() == "PLAIN":
                raw = base64.b64decode(parts[2]).split(b"\x00")
                user, pw = raw[1].decode(), raw[2].decode()
                if pw == "pass":
                    authed = True
                    await send("235 2.7.0 Authentication successful")
                else:
                    await send("535 5.7.8 Authentication failed")
            else:
                await send("504 Unsupported")
        elif verb == "MAIL":
            if not authed:
                await send("530 5.7.0 Authentication required")
            else:
                mail_from = line
                await send("250 OK")
        elif verb == "RCPT":
            rcpts.append(line)
            await send("250 OK")
        elif verb == "DATA":
            await send("354 End data with <CR><LF>.<CR><LF>")
            data = bytearray()
            while True:
                chunk = await reader.readline()
                if chunk in (b".\r\n", b".\n"):
                    break
                if chunk.startswith(b"."):
                    chunk = chunk[1:]
                data.extend(chunk)
            counter += 1
            path = os.path.join(OUTDIR, f"{counter}.eml")
            with open(path, "wb") as f:
                f.write(bytes(data))
            meta = os.path.join(OUTDIR, f"{counter}.envelope")
            with open(meta, "w") as f:
                f.write(f"{mail_from}\n" + "\n".join(rcpts) + "\n")
            print(f"sink: stored {path} ({len(data)} bytes, {len(rcpts)} rcpt)", flush=True)
            await send("250 2.0.0 OK queued")
            mail_from, rcpts = None, []
        elif verb == "QUIT":
            await send("221 Bye")
            break
        elif verb in ("RSET", "NOOP"):
            await send("250 OK")
        else:
            await send("502 Command not implemented")
    writer.close()


async def main():
    os.makedirs(OUTDIR, exist_ok=True)
    server = await asyncio.start_server(handle, "127.0.0.1", PORT)
    print(f"sink: listening on 127.0.0.1:{PORT}", flush=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())
