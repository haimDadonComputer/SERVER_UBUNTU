"""Read-only host TCP availability checks; never probes/starts Docker."""
import datetime
import pathlib
import ipaddress

def check_port(life,identifier,port,listen='127.0.0.1'):
    if type(port)!=int or not 1024<=port<=65535 or listen not in ('127.0.0.1','0.0.0.0'):
        raise ValueError('Invalid host port or listen address')
    p=life.lookup(identifier)
    result={'port':port,'listenAddress':listen,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'listeners':[]}
    for other_id,other in life.h['all_projects'](life.cfg).items():
        if other_id!=identifier and other.get('lifecycle','active')=='active' and other.get('runtime',{}).get('port')==port:
            return {**result,'status':'reserved','project':other_id}
    try:rows=life.h['parse_ss'](life.h['run'](['/usr/bin/ss','-H','-lntup']))
    except (OSError,ValueError):return {**result,'status':'unknown'}
    for row in rows:
        address=str(row.get('address','')).split('%',1)[0]
        if row.get('protocol')!='tcp' or row.get('port')!=port:continue
        if listen=='127.0.0.1' and address not in ('127.0.0.1','0.0.0.0','::','*'):continue
        if listen=='0.0.0.0' and address not in ('::','*'):
            try:
                if ipaddress.ip_address(address).version!=4:continue
            except ValueError:continue
        owned=False
        if row.get('pid') and p.get('ownership')=='managed':
            try:owned=any(life.names(identifier)['unit'] in line.split('/') for line in pathlib.Path('/proc/'+str(row['pid'])+'/cgroup').read_text().splitlines())
            except OSError:pass
        result['listeners'].append({'address':address,'pid':row.get('pid'),'process':row.get('process'),'owned':owned})
    result['status']='available' if not result['listeners'] else 'owned' if all(row['owned'] for row in result['listeners']) else 'occupied'
    return result
