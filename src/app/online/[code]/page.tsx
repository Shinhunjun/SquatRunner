import OnlineGame from '../../../components/OnlineGame';

export default async function HostPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <OnlineGame roomCode={code.toUpperCase()} />;
}
